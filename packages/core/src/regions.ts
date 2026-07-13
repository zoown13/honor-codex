export const KOREA_REGION_OPTIONS = [
  ["SEOUL", "서울"],
  ["BUSAN", "부산"],
  ["DAEGU", "대구"],
  ["INCHEON", "인천"],
  ["GWANGJU", "광주"],
  ["DAEJEON", "대전"],
  ["ULSAN", "울산"],
  ["SEJONG", "세종"],
  ["GYEONGGI", "경기"],
  ["GANGWON", "강원"],
  ["CHUNGBUK", "충북"],
  ["CHUNGNAM", "충남"],
  ["JEONBUK", "전북"],
  ["JEONNAM", "전남"],
  ["GYEONGBUK", "경북"],
  ["GYEONGNAM", "경남"],
  ["JEJU", "제주"],
] as const;

const KOREA_REGION_PATTERNS: Array<[RegExp, string]> = [
  [/서울특별시/, "SEOUL"], [/부산광역시/, "BUSAN"], [/대구광역시/, "DAEGU"],
  [/인천광역시/, "INCHEON"], [/광주광역시/, "GWANGJU"], [/대전광역시/, "DAEJEON"],
  [/울산광역시/, "ULSAN"], [/세종특별자치시/, "SEJONG"], [/경기도/, "GYEONGGI"],
  [/강원특별자치도|강원도/, "GANGWON"], [/충청북도/, "CHUNGBUK"], [/충청남도/, "CHUNGNAM"],
  [/전북특별자치도|전라북도/, "JEONBUK"], [/전라남도/, "JEONNAM"],
  [/경상북도/, "GYEONGBUK"], [/경상남도/, "GYEONGNAM"], [/제주특별자치도/, "JEJU"],
];

export function regionCodesForLocalGovernment(localGovernment: string): string[] {
  const name = localGovernment.trim();
  if (!name) return [];
  const region = KOREA_REGION_PATTERNS.find(([pattern]) => pattern.test(name))?.[1];
  return region ? [region, name] : [name];
}
