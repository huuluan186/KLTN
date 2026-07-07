import * as echarts from "echarts";
import { useEffect, useMemo, useRef, useState } from "react";
import { RISK_LEVELS } from "../../constants";
import { ECHARTS_COUNTRY_NAMES } from "../../lib/echartsCountries";
import type { RiskEntry } from "../../types/api";
import { resolveMapThemePalette, type MapTheme, type MapThemePalette } from "./mapTheme";

let mapRegistered = false;

async function ensureWorldMap() {
	if (mapRegistered) return;
	const res = await fetch("/world.json");
	if (!res.ok) throw new Error(`Failed to load world map: ${res.status}`);
	const geoJson = await res.json();
	echarts.registerMap("world", geoJson);
	mapRegistered = true;
}

interface MapDataItem {
	name: string;
	value: number;
	risk: keyof typeof RISK_LEVELS;
	itemStyle: { areaColor: string; borderColor?: string };
}

function buildOption(data: MapDataItem[], palette: MapThemePalette) {
	return {
		backgroundColor: palette.canvas,
		tooltip: {
			trigger: "item",
			backgroundColor: palette.tooltipBackground,
			borderColor: palette.tooltipBorder,
			textStyle: { color: palette.tooltipText, fontFamily: "Inter" },
			formatter: (p: { name: string; value: number; data?: MapDataItem }) => {
				if (!p.value && p.value !== 0) return `<b>${p.name}</b><br/>Chưa có dữ liệu`;
				const r = p.data?.risk ?? "none";
				const badge = `<span style="display:inline-block;margin-right:6px;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:3px;background:${palette.riskColors[r]};color:white;">${RISK_LEVELS[r].label}</span>`;
				return `<b>${p.name}</b><br/><br/>${badge} Xác suất rủi ro: <span style="font-weight:bold;font-size:14px;">${p.value}%</span>`;
			},
		},
		series: [
			{
				type: "map",
				map: "world",
				roam: true,
				roamTrigger: "global",
				scaleLimit: { min: 1, max: 8 },
				itemStyle: { areaColor: palette.land, borderColor: palette.border, borderWidth: 0.5 },
				emphasis: {
					itemStyle: {
						areaColor: palette.emphasis,
						borderColor: palette.emphasisBorder,
						borderWidth: 1,
					},
					label: { show: false },
				},
				data,
			},
		],
	};
}

interface Props {
	entries: RiskEntry[];
	theme: MapTheme;
	onCountrySelect: (echartName: string) => void;
}

export default function WorldMap({ entries, theme, onCountrySelect }: Props) {
	const elRef = useRef<HTMLDivElement | null>(null);
	const chartRef = useRef<echarts.ECharts | null>(null);
	const [ready, setReady] = useState(false);
	const palette = useMemo(() => resolveMapThemePalette(theme), [theme]);

	const mapData = useMemo<MapDataItem[]>(() => {
		return entries
			.filter((e) => ECHARTS_COUNTRY_NAMES[e.iso3])
			.map((e) => ({
				name: ECHARTS_COUNTRY_NAMES[e.iso3],
				value: e.score,
				risk: e.risk,
				itemStyle: { areaColor: palette.riskColors[e.risk], borderColor: palette.riskBorder },
			}));
	}, [entries, palette.riskBorder, palette.riskColors]);

	const mapDataRef = useRef(mapData);
	useEffect(() => {
		mapDataRef.current = mapData;
	});

	// Stable onCountrySelect via ref — tránh re-init chart khi parent re-render
	const onSelectRef = useRef(onCountrySelect);
	useEffect(() => {
		onSelectRef.current = onCountrySelect;
	}, [onCountrySelect]);

	useEffect(() => {
		let mounted = true;
		ensureWorldMap()
			.then(() => mounted && setReady(true))
			.catch((err) => console.error("World map load failed:", err));
		return () => {
			mounted = false;
		};
	}, []);

	useEffect(() => {
		if (!ready || !elRef.current) return;
		const el = elRef.current;

		// Đợi container có size hợp lệ trước khi init echarts.
		// Nếu init với element 0x0, canvas blank và không tự phục hồi khi size đổi.
		let ch: echarts.ECharts | null = null;

		const initIfReady = () => {
			if (ch) return; // đã init
			const { width, height } = el.getBoundingClientRect();
			if (width < 1 || height < 1) return;
			ch = echarts.init(el);
			chartRef.current = ch;
			ch.setOption(buildOption(mapDataRef.current, palette));
			ch.on("click", (params: { name?: string }) => {
				if (params.name) onSelectRef.current(params.name);
			});
		};

		// Try init ngay; nếu container chưa lay out, sẽ skip — ResizeObserver fire khi có size.
		initIfReady();

		const ro = new ResizeObserver(() => {
			initIfReady(); // init lần đầu nếu trước đó skip
			ch?.resize(); // resize nếu đã init
		});
		ro.observe(el);

		const onWindowResize = () => ch?.resize();
		window.addEventListener("resize", onWindowResize);

		return () => {
			window.removeEventListener("resize", onWindowResize);
			ro.disconnect();
			ch?.dispose();
			chartRef.current = null;
		};
	}, [ready, palette]);

	useEffect(() => {
		chartRef.current?.setOption(buildOption(mapData, palette));
	}, [mapData, palette]);

	useEffect(() => {
		chartRef.current?.setOption({
			series: [
				{
					type: "map",
					map: "world",
					data: mapData,
				},
			],
		});
	}, [mapData]);

	return (
		<div className="w-full h-full relative" style={{ background: palette.canvas }}>
			{!ready && (
				<div className="absolute inset-0 grid place-items-center text-[var(--color-text-3)] text-xs">
					Đang tải bản đồ thế giới…
				</div>
			)}
			<div ref={elRef} className="absolute inset-0" />
		</div>
	);
}
