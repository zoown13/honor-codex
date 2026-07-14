import type { RawMmaFacility } from "../../src/types.js";

export const mmaFacilityFixture: RawMmaFacility = {
  addr: "강원특별자치도춘천시신동면김유정로 1383(신동면증리)",
  displayaddr: "강원특별자치도 춘천시",
  drjbc_cd: "08",
  gyeongdo_vl: "127.711765",
  hmpg_addr: "www.railpark.co.kr",
  mmgudgigwan_cd: "2689",
  udae_gbcd: "02",
  udae_ggm: "(주)강촌레일파크",
  udggeopjong_gbcd: "09",
  udgigwan_telno: "033-245-1000",
  udgigwan_yhcd: "01",
  udhangmok_gbcd: "10",
  udjiyeok_cd: "02",
  udsangse_cn: "김유정역, 경강역, 가평역 레일바이크 이용요금의 20% 할인 / 전국 병역명문가 본인 및 가족(명문가증, 가족관계서류 제시)",
  wido_vl: "37.818336",
};

export const mmaJsonpFixture = `honorPilot(${JSON.stringify({ success: true, list: [mmaFacilityFixture] })});`;

export const ordinanceJsonFixture = JSON.stringify({
  OrdinSearch: {
    target: "ordin",
    section: "ordinNm",
    totalCnt: "1",
    page: "1",
    numOfRows: "1",
    resultCode: "00",
    law: [{
      "자치법규ID": "1234567",
      "자치법규명": "서울특별시 병역명문가 예우에 관한 조례",
      "지자체기관명": "서울특별시",
      "공포일자": "20250101",
      "시행일자": "20250101",
      "제개정구분명": "일부개정",
      "자치법규상세링크": "https://www.law.go.kr/example",
    }],
  },
});
