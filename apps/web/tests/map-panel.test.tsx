import type { SearchResult } from "@honor/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { benefits } from "../data/sample-benefits";

vi.mock("../lib/config", () => ({ KAKAO_MAP_APP_KEY: "test-kakao-key" }));

import { MapPanel } from "../components/map-panel";

interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
  centerLatitude: number;
  centerLongitude: number;
}

type Listener = () => void;

let viewport: Viewport;
let listeners: WeakMap<object, Map<string, Set<Listener>>>;
let markerInstances: FakeMarker[];
let infoWindowInstances: FakeInfoWindow[];

class FakeLatLng {
  constructor(readonly latitude: number, readonly longitude: number) {}
  getLat() { return this.latitude; }
  getLng() { return this.longitude; }
}

class FakeKakaoMap {
  static lastInstance: FakeKakaoMap | undefined;

  constructor(_element: HTMLElement, _options: { center: FakeLatLng; level: number }) {
    FakeKakaoMap.lastInstance = this;
  }

  getBounds() {
    return {
      contain: (position: FakeLatLng) => position.latitude >= viewport.south
        && position.latitude <= viewport.north
        && position.longitude >= viewport.west
        && position.longitude <= viewport.east
    };
  }

  getCenter() {
    return new FakeLatLng(viewport.centerLatitude, viewport.centerLongitude);
  }
}

class FakeMarker {
  readonly setMap = vi.fn((_map: FakeKakaoMap | null) => undefined);

  constructor(readonly options: {
    map: FakeKakaoMap;
    position: FakeLatLng;
    title?: string;
  }) {
    markerInstances.push(this);
  }
}

class FakeInfoWindow {
  constructor(readonly options: {
    content: HTMLElement;
    removable?: boolean;
    disableAutoPan?: boolean;
  }) {
    infoWindowInstances.push(this);
  }

  open(_map: FakeKakaoMap, _marker: FakeMarker) {
    document.body.append(this.options.content);
  }

  close() {
    this.options.content.remove();
  }
}

const eventApi = {
  addListener(target: object, event: string, listener: Listener) {
    let eventMap = listeners.get(target);
    if (!eventMap) {
      eventMap = new Map();
      listeners.set(target, eventMap);
    }
    let eventListeners = eventMap.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      eventMap.set(event, eventListeners);
    }
    eventListeners.add(listener);
  },
  removeListener(target: object, event: string, listener: Listener) {
    listeners.get(target)?.get(event)?.delete(listener);
  }
};

const baseFacility: SearchResult = benefits.find((benefit) => benefit.type === "FACILITY") ?? missingFacility();

describe("MapPanel", () => {
  beforeEach(() => {
    viewport = {
      south: 37,
      west: 126,
      north: 38,
      east: 128,
      centerLatitude: 37.55,
      centerLongitude: 127
    };
    listeners = new WeakMap();
    FakeKakaoMap.lastInstance = undefined;
    markerInstances = [];
    infoWindowInstances = [];

    Object.defineProperty(window, "kakao", {
      configurable: true,
      value: {
        maps: {
          load: (callback: () => void) => callback(),
          LatLng: FakeLatLng,
          Map: FakeKakaoMap,
          Marker: FakeMarker,
          InfoWindow: FakeInfoWindow,
          event: eventApi
        }
      }
    });
    const script = document.createElement("script");
    script.dataset.honorKakaoMap = "true";
    document.head.appendChild(script);
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll("script[data-honor-kakao-map]").forEach((element) => element.remove());
    Reflect.deleteProperty(window, "kakao");
  });

  it("opens safe marker information with app detail and Kakao Map actions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const seoul = facility("seoul", "서울 테스트 시설", 37.56, 127.03);

    render(<MapPanel items={[seoul]} onSelect={onSelect} />);

    await screen.findByText("지도 안 1곳");
    const marker = markerInstances.find((item) => item.options.title === seoul.title);
    expect(marker).toBeDefined();
    emit(marker!, "click");

    const information = await screen.findByRole("group", { name: "서울 테스트 시설 지도 정보" });
    expect(infoWindowInstances[0]?.options.disableAutoPan).toBe(true);
    expect(within(information).getByText(seoul.displayAddress!)).toBeVisible();
    const kakaoLink = within(information).getByRole("link", { name: /카카오맵에서 보기/ });
    expect(kakaoLink.getAttribute("href")).toContain(encodeURIComponent(seoul.title));
    await user.click(within(information).getByRole("button", { name: "혜택 상세 보기" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: seoul.id }));
  });

  it("refreshes markers and the list from the current bounds, including items after the old 80-item cutoff", async () => {
    const seoulItems = Array.from({ length: 81 }, (_, index) =>
      facility(`seoul-${index}`, `서울 시설 ${index}`, 37.5 + (index % 10) * 0.001, 127)
    );
    const busan = facility("busan-81", "부산 81번째 이후 시설", 35.18, 129.08);
    const withoutLocation = facilityWithoutLocation("no-location", "좌표 없는 시설");

    render(<MapPanel items={[...seoulItems, busan, withoutLocation]} onSelect={vi.fn()} />);

    await screen.findByText("지도 안 81곳");
    expect(screen.queryByText(busan.title)).not.toBeInTheDocument();
    expect(screen.getByText(/좌표가 없는 시설은 지도 목록에서 제외/)).toBeVisible();
    const initialMarker = markerInstances[0];
    expect(initialMarker).toBeDefined();

    act(() => {
      viewport = {
        south: 34.8,
        west: 128.7,
        north: 35.5,
        east: 129.4,
        centerLatitude: 35.18,
        centerLongitude: 129.08
      };
      emit(FakeKakaoMap.lastInstance!, "idle");
    });

    await screen.findByText("지도 안 1곳");
    expect(screen.getByText(busan.title)).toBeVisible();
    expect(screen.queryByText("서울 시설 0")).not.toBeInTheDocument();
    await waitFor(() => expect(initialMarker!.setMap).toHaveBeenCalledWith(null));
    const busanMarker = markerInstances.at(-1);
    expect(busanMarker?.options.title).toBe(busan.title);

    emit(busanMarker!, "click");
    await screen.findByRole("group", { name: `${busan.title} 지도 정보` });

    act(() => {
      viewport = {
        south: 33,
        west: 125,
        north: 34,
        east: 126,
        centerLatitude: 33.5,
        centerLongitude: 125.5
      };
      emit(FakeKakaoMap.lastInstance!, "idle");
    });

    await screen.findByText("지도 안 0곳");
    expect(screen.getByText("현재 지도 영역에 표시할 시설이 없습니다.")).toBeVisible();
    expect(screen.queryByText(busan.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: `${busan.title} 지도 정보` })).not.toBeInTheDocument();
    await waitFor(() => expect(busanMarker!.setMap).toHaveBeenCalledWith(null));
  });

  it("clears the previous viewport when filters leave no mappable facilities", async () => {
    const seoul = facility("seoul-zero", "필터 전 서울 시설", 37.56, 127.03);
    const onSelect = vi.fn();
    const { rerender } = render(<MapPanel items={[seoul]} onSelect={onSelect} />);

    await screen.findByText("지도 안 1곳");
    rerender(<MapPanel items={[]} onSelect={onSelect} />);

    await screen.findByText("조건에 맞는 좌표 시설이 없습니다.");
    expect(screen.getByText("0곳", { selector: ".result-count" })).toBeVisible();
    expect(screen.queryByText(seoul.title)).not.toBeInTheDocument();
  });
});

function emit(target: object, event: string) {
  listeners.get(target)?.get(event)?.forEach((listener) => listener());
}

function facility(id: string, title: string, latitude: number, longitude: number): SearchResult {
  return {
    ...baseFacility,
    id: `fac:test-${id}`,
    title,
    provider: title,
    address: `${title} 주소`,
    displayAddress: `${title} 표시 주소`,
    location: { latitude, longitude, provenance: "MMA" },
    source: { ...baseFacility.source, id: `source-${id}` },
    searchText: `${title} 테스트`
  };
}

function facilityWithoutLocation(id: string, title: string): SearchResult {
  const { location: _location, ...item } = facility(id, title, 37.5, 127);
  return item;
}

function missingFacility(): never {
  throw new Error("sample facility is required");
}
