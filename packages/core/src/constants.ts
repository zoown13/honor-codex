export const UNKNOWN_OFFICIAL_DETAIL =
  "공식 문서에 명시되지 않음—시설 또는 담당부서 확인 필요";

export const MMA_REGION_NAMES: Record<string, string> = {
  "01": "강원영동",
  "02": "강원",
  "03": "경기북부",
  "04": "경남",
  "05": "광주전남",
  "06": "대구경북",
  "07": "대전충남",
  "08": "부산울산",
  "09": "서울",
  "10": "인천경기",
  "11": "전국",
  "12": "전북",
  "13": "제주",
  "14": "충북"
};

export const MMA_REGION_CODES: Record<string, string[]> = {
  "01": ["GANGWON"],
  "02": ["GANGWON"],
  "03": ["GYEONGGI"],
  "04": ["GYEONGNAM"],
  "05": ["GWANGJU", "JEONNAM"],
  "06": ["DAEGU", "GYEONGBUK"],
  "07": ["DAEJEON", "CHUNGNAM", "SEJONG"],
  "08": ["BUSAN", "ULSAN"],
  "09": ["SEOUL"],
  "10": ["INCHEON", "GYEONGGI"],
  "11": ["NATIONAL"],
  "12": ["JEONBUK"],
  "13": ["JEJU"],
  "14": ["CHUNGBUK"]
};

export const MMA_CATEGORY_NAMES: Record<string, string> = {
  "01": "공원",
  "02": "교육",
  "03": "궁능원/유적지",
  "04": "기념관/박물관",
  "05": "기타",
  "06": "문화",
  "07": "병원",
  "08": "숙박",
  "09": "스포츠/레저",
  "10": "은행",
  "11": "음식점",
  "12": "자연휴양림",
  "13": "관광지",
  "14": "주차장",
  "15": "장례시설",
  "16": "안경점",
  "17": "미용실",
  "18": "카페",
  "19": "여행사",
  "20": "전자제품",
  "21": "사진관",
  "22": "학원"
};

export const MMA_BENEFIT_KIND: Record<string, "FREE" | "DISCOUNT" | "OTHER"> = {
  "01": "FREE",
  "02": "DISCOUNT",
  "03": "OTHER"
};
