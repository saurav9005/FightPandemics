const { DateHelper } = require("./date-helper");
const { EmailFrequency } = require("../models/email-frequency");
const { MessageThreadStatus } = require("../models/message-thread-status");
const { MongoClient } = require("mongodb");
const { NotificationAction } = require("../models/notification-action");

class DatabaseHelper {
  constructor(config) {
    this.uri = this._buildUri(config);
    this.dbName = config.database;
    this.db = null;
    this.instantUnreadLookbackInterval = config.instantUnreadLookbackInterval;
  }

  async connect(cachedDb = null) {
    if (cachedDb && cachedDb.serverConfig.isConnected()) {
      this.db = cachedDb;
    } else {
      const client = await MongoClient.connect(this.uri);
      this.db = client.db(this.dbName);
    }
  }

  async findNotifications(frequency) {
    if (frequency === EmailFrequency.INSTANT) {
      return this._findInstantNotifications();
    }
    return this._findDigestNotifications(frequency);
  }

  async findUnreadDirectMessages() {
    const threads = await this.db
      .collection("threads")
      .aggregate([
        {
          $match: {
            "participants.newMessages": { $gt: 0 },
            "participants.lastAccess": {
              $lt: DateHelper.subtractMinutes(
                new Date(),
                this.instantUnreadLookbackInterval,
              ),
              // Don't send out instant notifications for anything older than 30 minutes
              // TODO uncomment after done dev testing
              // $gt: DateHelper.subtractMinutes(new Date(), 30),
            },
            "participants.status": {
              $in: [MessageThreadStatus.ACCEPTED, MessageThreadStatus.PENDING],
            },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "participants.id",
            foreignField: "_id",
            as: "users",
          },
        },
      ])
      .toArray();

    const threadIds = threads.map((thread) => thread._id);

    // Convert threads array to object keyed by thread ID for O(1) lookup
    // See https://www.olioapps.com/blog/map-reduce/ for indexing an array of objects
    const threadsObject = threads.reduce(
      (accumulator, thread) => ({ ...accumulator, [thread._id]: thread }),
      {},
    );

    const messagesCursor = this.db.collection("messages").aggregate([
      {
        $match: {
          threadId: { $in: threadIds },
          // emailSentAt: null, // TODO need to add this field to messages collection
        },
      },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: "$threadId",
          latestMessage: {
            $last: "$$ROOT",
          },
        },
      },
    ]);

    const messages = [];

    while (await messagesCursor.hasNext()) {
      const message = await messagesCursor.next();
      const thread = threadsObject[message._id];
      /*
        The thread.participants array will always have only two elements in it
        (at least for direct messages). One of these participants is a sender
        while the other is a receiver. The newMessages count for participants
        is mutually exclusive in that only one of the participants will have
        this count greater than 0, while the other will have this count equal
        to 0. Therefore we can assume that the sender is the participant with
        newMessages count equal to 0, while the receiver is the participant
        with newMessages greater than 0.
      */
      const sender = thread.participants.find((p) => p.newMessages === 0);
      const receiver = thread.participants.find((p) => p.newMessages > 0);
      if (sender === undefined || receiver === undefined) {
        continue;
      }
      const receiverUser = thread.users.find(
        (user) => user._id.toString() === receiver.id.toString(),
      );
      const { notifyPrefs, email } = receiverUser;
      if (notifyPrefs && !notifyPrefs.instant.message) {
        // Receiver has disabled instant notifications for direct messages
        continue;
      }
      messages.push({
        sender: { ...sender },
        receiver: { ...receiver, email },
        message: { ...message.latestMessage },
      });
    }

    return messages;
  }

  async setEmailSentAt(notificationIds, frequency) {
    return this.db.collection("notifications").updateMany(
      {
        _id: { $in: notificationIds },
      },
      {
        $set: {
          [`emailSentAt.${frequency}`]: new Date(),
        },
      },
    );
  }

  async _findInstantNotifications() {
    const cursor = this.db.collection("notifications").aggregate([
      {
        $match: {
          readAt: null,
          "emailSentAt.instant": null,
          createdAt: {
            $lt: DateHelper.subtractMinutes(
              new Date(),
              this.instantUnreadLookbackInterval,
            ),
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "receiver",
          foreignField: "_id",
          as: "receiver",
        },
      },
      {
        $unwind: {
          path: "$receiver",
        },
      },
    ]);
    const notifications = await cursor.toArray();
    // Set emailSentAt timestamp right away so we don't risk sending duplicate emails.
    await this.setEmailSentAt(
      notifications.map((notification) => notification._id),
      EmailFrequency.INSTANT,
    );
    return notifications;
  }

  async _findDigestNotifications(frequency) {
    let intervalDays;
    if (frequency === EmailFrequency.DAILY) {
      intervalDays = 1;
    } else if (frequency === EmailFrequency.WEEKLY) {
      intervalDays = 7;
    } else if (frequency === EmailFrequency.BIWEEKLY) {
      intervalDays = 14;
    }

    const notificationsByReceiverCursor = this.db
      .collection("notifications")
      .aggregate([
        {
          $match: {
            [`emailSentAt.${frequency}`]: null,
            createdAt: {
              $gt: DateHelper.subtractDays(new Date(), intervalDays),
            },
          },
        },
        {
          $group: {
            _id: "$receiver",
            notifications: {
              $push: "$$ROOT",
            },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "receiver",
          },
        },
        {
          $unwind: {
            path: "$receiver",
          },
        },
      ]);

    const digests = [];
    const processedNotificationIds = [];

    while (await notificationsByReceiverCursor.hasNext()) {
      const receiver = await notificationsByReceiverCursor.next();
      const topThreePosts = this._aggregateNotifications(
        receiver.notifications,
      );
      digests.push({
        posts: topThreePosts,
        receiver: receiver.receiver,
      });
      for (const notification of receiver.notifications) {
        processedNotificationIds.push(notification._id);
      }
    }

    // Set emailSentAt timestamp right away so we don't risk sending duplicate emails.
    await this.setEmailSentAt(processedNotificationIds, frequency);

    return digests;
  }

  _aggregateNotifications(notifications) {
    const notificationCountsByPost = {};
    for (const notification of notifications) {
      const postId = notification.post.id;
      const action = notification.action;
      if (!notificationCountsByPost.hasOwnProperty(postId)) {
        notificationCountsByPost[postId] = {
          latest: null,
          post: notification.post,
          counts: {
            comment: 0,
            like: 0,
            share: 0,
            total: 0,
          },
        };
      }
      notificationCountsByPost[postId].counts[action] += 1;
      notificationCountsByPost[postId].counts.total += 1;
      if (notification.action !== NotificationAction.COMMENT) {
        continue;
      }
      if (!notificationCountsByPost[postId].latest) {
        notificationCountsByPost[postId].latest = notification;
        continue;
      }
      if (
        notificationCountsByPost[postId].latest.createdAt <
        notification.createdAt
      ) {
        notificationCountsByPost[postId].latest = notification;
      }
    }

    const topThreePosts = Object.values(notificationCountsByPost)
      .sort((a, b) => b.counts.total - a.counts.total)
      .slice(0, 3);
    return topThreePosts;
  }

  _buildUri(config) {
    const usernamePassword =
      config.username && config.password
        ? `${config.username}:${config.password}@`
        : "";
    const port = config.port ? `:${config.port}` : "";
    const retryWrites = config.retryWrites
      ? "?retryWrites=true&w=majority"
      : "";
    const uri = `${config.protocol}://${usernamePassword}${config.host}${port}${retryWrites}`;
    return uri;
  }
}

module.exports = {
  DatabaseHelper,
};
