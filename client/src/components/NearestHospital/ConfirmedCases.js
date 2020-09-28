import React, { useState, useEffect } from "react";
import axios from "axios";
import styled from "styled-components";

import SearchInput from "../Input/SearchInput";
import { getLocalStorageJson } from "utils/local-storage";

import { theme, mq } from "../../constants/theme";
const { typography, colors } = theme;
const { white, mediumGray } = colors;
const { large, xxxlarge } = typography.size;

const ConfirmedCasesContainer = styled.div`
  background-color: ${white};
  border: 0.2px solid rgba(185, 185, 185, 0.5);
  padding: 4rem 3rem;
  margin-top: 4rem;
  @media screen and (max-width: ${mq.phone.wide.maxWidth}) {
    border: 0;
    padding: 0;
    margin-top: 0;
  }
`;

const ConfirmedCasesContent = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-around;
  margin-top: 6rem;
  div:not(:last-child) {
    border-right: 0.1rem solid ${mediumGray};
  }
  div {
    padding: 0 5rem;
    h2 {
      font-weight: bold;
      font-size: ${xxxlarge};
      margin-bottom: 0;
    }
  }
  @media screen and (max-width: ${mq.phone.wide.maxWidth}) {
    display: block;
    margin-top: 0;
    div:not(:last-child) {
      border-right: 0;
    }
    div {
      padding: 3rem 0 0 2rem;
      border-bottom: 1px solid ${mediumGray};
      h2 {
        font-size: ${xxxlarge};
      }
      p {
        font-size: ${large};
        margin-bottom: 0.5em;
      }
    }
  }
`;

const SearchBarContainer = styled.div`
  width: 40%;
  @media screen and (max-width: ${mq.phone.wide.maxWidth}) {
    display: none;
  }
`;

const NearestHealthFacilities = (props) => {
  //TO-DO: Pull location data.
  const userLocation = {
    address: "Venice Ave, Staten Island, NY 10304, USA",
    coordinates: [-74.0927225, 40.6024931],
    country: "IT",
    neighborhood: "Todt Hill",
    state: "New York",
    zip: "10304",
  };
      
  //Fetch Country and Global Data
  const [caseCountGlobal, setCaseCountGlobal] = useState(null);
  const [caseCountryData, setCaseCountryData] = useState(null);
  
  useEffect(() => {
    const casesUrl = `https://api.covid19api.com/summary`;
    axios
      .get(casesUrl)
      .then((res) => {
        const globalCount = res?.data?.Global?.TotalConfirmed;
        const countryList = res?.data?.Countries;
        const countryData = countryList.find((countryObject) => {
          return countryObject.CountryCode === userLocation?.country;
        });
        const countryCount = countryData.TotalConfirmed;
        const countryName = countryData.Country;
        setCaseCountGlobal(globalCount);
        setCaseCountryData([countryCount,countryName]);
      })
      .catch((err) => console.error(err));
  },[]);
  
  const [searchValue, setSearchValue] = useState("");

  const onSearchInputChange = (value) => {
    setSearchValue(value);
  };
  const clearSearch = () => {
    setSearchValue("");
  };

  return (
    <ConfirmedCasesContainer>
      <SearchBarContainer>
        <SearchInput
          value={searchValue}
          placeholder=""
          onClear={clearSearch}
          onChange={onSearchInputChange}
        />
      </SearchBarContainer>
      <ConfirmedCasesContent>
        <div>
          <h2>{caseCountryData === null ? 'No data' : caseCountryData[0].toLocaleString('en')}</h2>
          <p>Confirmed cases in {caseCountryData === null ? '' : caseCountryData[1]}</p>
        </div>
        <div>
          <h2>{caseCountGlobal === null ? 'No data' : caseCountGlobal.toLocaleString('en')}</h2>
          <p>Confirmed cases in World</p>
        </div>
      </ConfirmedCasesContent>
    </ConfirmedCasesContainer>
  );
};

export default NearestHealthFacilities;
