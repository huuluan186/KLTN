import * as echarts from "echarts";
import { useEffect, useMemo, useRef } from "react";
import { attachChartResize } from "../../lib/echartsResize";
import type { HistoryPoint } from "../../types/api";

// Tái hiện Hình 4.4 trong notebook: heatmap số ca theo tuần (cột) × năm (hàng),
// 2010-2019, để thấy quy luật mùa vụ lặp lại. Dùng số ca thực tế (actual_cases);
// tuần nào không có báo cáo thì để trống.
const YEAR_START = 2010;
const YEAR_END = 2019;
const WEEKS = 53;

// Phổ xanh dương sáng → navy đậm. Bắt đầu từ xanh trung bình (không gần trắng)
// để ô ca thấp vẫn rõ trên nền trắng; đỉnh dịch thành navy đậm, nổi bật nhất.
const SEQ_BLUES = [
	"#93c5fd",
	"#60a5fa",
	"#3b82f6",
	"#2563eb",
	"#1d4ed8",
	"#1e40af",
	"#172554",
];

// Màu ô không có báo cáo (missing). Xám trung tính, phân biệt rõ với nền trắng
// lẫn với ô ca = 0 (vốn tô xanh nhạt nhất).
const NO_DATA_COLOR = "#94a3b8";

interface Props {
	points: HistoryPoint[];
	disease: "flu" | "dengue";
}

export default function SeasonalHeatmap({ points, disease }: Props) {
	const elRef = useRef<HTMLDivElement>(null);

	const { years, data, max } = useMemo(() => {
		const yearSet = new Set<number>();
		for (const p of points) {
			if (p.iso_year >= YEAR_START && p.iso_year <= YEAR_END) yearSet.add(p.iso_year);
		}
		const years = [...yearSet].sort((a, b) => a - b);
		const yearIndex = new Map(years.map((y, i) => [y, i]));

		const data: [number, number, number][] = [];
		let max = 0;
		for (const p of points) {
			if (p.iso_year < YEAR_START || p.iso_year > YEAR_END) continue;
			const value = p.actual_cases;
			if (value == null) continue;
			const yi = yearIndex.get(p.iso_year);
			if (yi == null) continue;
			data.push([p.iso_week - 1, yi, value]);
			if (value > max) max = value;
		}
		return { years, data, max };
	}, [points]);

	useEffect(() => {
		if (!elRef.current || years.length === 0) return;
		const ch = echarts.init(elRef.current);

		ch.setOption({
			backgroundColor: "transparent",
			// show + backgroundColor tô nền vùng lưới bằng màu xám: mọi ô không có
			// heatmap item (tuần thiếu báo cáo) sẽ lộ nền xám này.
			grid: { top: 8, right: 12, bottom: 84, left: 52, show: true, backgroundColor: NO_DATA_COLOR, borderWidth: 0 },
			tooltip: {
				position: "top",
				backgroundColor: "#ffffff",
				borderColor: "#cbd5e1",
				textStyle: { color: "#1e293b", fontSize: 12 },
				formatter: (p: { data: [number, number, number] }) => {
					const [wi, yi, v] = p.data;
					return `Năm ${years[yi]} · Tuần ${String(wi + 1).padStart(2, "0")}<br/><b>${Math.round(v).toLocaleString("vi-VN")}</b> ca`;
				},
			},
			xAxis: {
				type: "category",
				data: Array.from({ length: WEEKS }, (_, i) => i + 1),
				name: "Tuần ISO",
				nameLocation: "middle",
				nameGap: 28,
				nameTextStyle: { color: "#334155", fontSize: 12, fontWeight: "bold" },
				splitArea: { show: false },
				axisLine: { lineStyle: { color: "#94a3b8" } },
				axisLabel: { color: "#334155", fontSize: 11, interval: 3 },
				axisTick: { show: false },
			},
			yAxis: {
				type: "category",
				data: years.map(String),
				axisLine: { lineStyle: { color: "#94a3b8" } },
				axisLabel: { color: "#334155", fontSize: 12 },
				axisTick: { show: false },
				splitArea: { show: false },
			},
			visualMap: {
				min: 0,
				max: Math.max(max, 1),
				calculable: true,
				orient: "horizontal",
				left: "center",
				bottom: 10,
				itemWidth: 14,
				itemHeight: 180,
				textStyle: { color: "#334155", fontSize: 11 },
				inRange: { color: SEQ_BLUES },
			},
			series: [
				{
					name: "Số ca",
					type: "heatmap",
					data,
					progressive: 0,
					itemStyle: { borderColor: "#ffffff", borderWidth: 0.5 },
					emphasis: { itemStyle: { borderColor: "#1e293b", borderWidth: 1 } },
				},
			],
		});

		return attachChartResize(elRef.current, ch);
	}, [years, data, max, disease]);

	if (years.length === 0) {
		return (
			<div className="h-[260px] grid place-items-center text-[var(--color-text-3)] text-xs">
				Chưa có dữ liệu lịch sử 2010-2019 cho quốc gia này.
			</div>
		);
	}

	return <div ref={elRef} className="w-full h-[260px]" />;
}
