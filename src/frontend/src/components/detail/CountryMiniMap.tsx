import * as echarts from "echarts";
import { useEffect, useMemo, useRef, useState } from "react";
import { attachChartResize } from "../../lib/echartsResize";
import { ECHARTS_COUNTRY_NAMES } from "../../lib/echartsCountries";

let mapRegistered = false;
let geoCache: GeoJson | null = null;

interface GeoFeature {
	properties: { name?: string };
	geometry: { type: string; coordinates: unknown };
}
interface GeoJson {
	features: GeoFeature[];
}

async function ensureWorldMap(): Promise<GeoJson> {
	if (geoCache && mapRegistered) return geoCache;
	const res = await fetch("/world.json");
	if (!res.ok) throw new Error(`Failed to load world map: ${res.status}`);
	const geoJson = (await res.json()) as GeoJson;
	if (!echarts.getMap("world")) {
		echarts.registerMap("world", geoJson as unknown as Parameters<typeof echarts.registerMap>[1]);
	}
	mapRegistered = true;
	geoCache = geoJson;
	return geoJson;
}

// Duyệt đệ quy mọi cặp [lng, lat] trong geometry (Polygon / MultiPolygon)
// để lấy bounding box — dùng tính center + zoom cho echarts.
function collectBounds(coords: unknown, acc: number[]) {
	if (!Array.isArray(coords)) return;
	if (typeof coords[0] === "number" && typeof coords[1] === "number") {
		const [lng, lat] = coords as number[];
		acc[0] = Math.min(acc[0], lng);
		acc[1] = Math.min(acc[1], lat);
		acc[2] = Math.max(acc[2], lng);
		acc[3] = Math.max(acc[3], lat);
		return;
	}
	for (const c of coords) collectBounds(c, acc);
}

interface Props {
	iso3: string;
	riskColor: string;
	onClick?: () => void;
}

export default function CountryMiniMap({ iso3, riskColor, onClick }: Props) {
	const elRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<echarts.ECharts | null>(null);
	const [geo, setGeo] = useState<GeoJson | null>(null);
	const [error, setError] = useState(false);

	const echartsName = ECHARTS_COUNTRY_NAMES[iso3.toUpperCase()];

	const view = useMemo(() => {
		if (!geo || !echartsName) return null;
		const feature = geo.features.find((f) => f.properties?.name === echartsName);
		if (!feature) return null;
		const bounds = [Infinity, Infinity, -Infinity, -Infinity];
		collectBounds(feature.geometry.coordinates, bounds);
		const [minLng, minLat, maxLng, maxLat] = bounds;
		if (!Number.isFinite(minLng)) return null;
		const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
		const spanLng = Math.max(maxLng - minLng, 1);
		const spanLat = Math.max(maxLat - minLat, 1);
		// zoom=1 hiển thị toàn bộ map (360° x 180°). Chia world span / country span
		// rồi nhân hệ số 0.55 để chừa lề, clamp tránh zoom quá sâu với nước nhỏ.
		const zoom = Math.min(Math.max(Math.min(360 / spanLng, 180 / spanLat) * 0.55, 1.2), 18);
		return { center, zoom };
	}, [geo, echartsName]);

	useEffect(() => {
		let mounted = true;
		ensureWorldMap()
			.then((g) => mounted && setGeo(g))
			.catch(() => mounted && setError(true));
		return () => {
			mounted = false;
		};
	}, []);

	useEffect(() => {
		if (!elRef.current || !geo || !view) return;
		// Dispose instance cũ nếu còn sót (React StrictMode double-invoke hoặc deps thay đổi
		// nhanh trước khi cleanup kịp chạy) để tránh ECharts throw "already initialized".
		echarts.getInstanceByDom(elRef.current)?.dispose();
		const ch = echarts.init(elRef.current);
		chartRef.current = ch;

		ch.setOption({
			backgroundColor: "transparent",
			series: [
				{
					type: "map",
					map: "world",
					roam: false,
					center: view.center,
					zoom: view.zoom,
					itemStyle: {
						areaColor: "#243042",
						borderColor: "#0f172a",
						borderWidth: 0.5,
					},
					emphasis: { disabled: true },
					select: { disabled: true },
					silent: true,
					data: echartsName
						? [
								{
									name: echartsName,
									itemStyle: {
										areaColor: riskColor,
										borderColor: "#e2e8f0",
										borderWidth: 1.2,
									},
								},
							]
						: [],
				},
			],
		});

		const detach = attachChartResize(elRef.current, ch);
		return () => {
			detach();
			chartRef.current = null;
		};
	}, [geo, view, echartsName, riskColor]);

	if (error || (geo && !view)) {
		return (
			<div className="h-[200px] grid place-items-center text-[var(--color-text-3)] text-[11px] text-center px-3">
				Không có ranh giới bản đồ cho quốc gia này.
			</div>
		);
	}

	const interactive = Boolean(onClick);

	return (
		<div
			onClick={onClick}
			onKeyDown={(e) => {
				if (interactive && (e.key === "Enter" || e.key === " ")) {
					e.preventDefault();
					onClick?.();
				}
			}}
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			title={interactive ? "Xem quốc gia này trên bản đồ tổng" : undefined}
			className={`group relative h-[200px] rounded-lg bg-[var(--color-map-dark-ocean)] overflow-hidden border border-transparent ${
				interactive
					? "cursor-pointer hover:border-[var(--color-focus-accent)] focus:outline-none focus-visible:border-[var(--color-focus-accent)] transition-colors"
					: ""
			}`}
		>
			{!geo && (
				<div className="absolute inset-0 grid place-items-center text-[var(--color-text-3)] text-[11px]">
					Đang tải bản đồ…
				</div>
			)}
			<div ref={elRef} className="absolute inset-0" />
			{interactive && geo && view && (
				<div className="absolute inset-x-0 bottom-0 px-2 py-1 text-center text-[10px] font-semibold text-white bg-black/55 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
					Xem trên bản đồ tổng →
				</div>
			)}
		</div>
	);
}
