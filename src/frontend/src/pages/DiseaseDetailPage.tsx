import * as echarts from "echarts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";
import CountryMiniMap from "../components/detail/CountryMiniMap";
import ForecastChart from "../components/detail/ForecastChart";
import SeasonalHeatmap from "../components/detail/SeasonalHeatmap";
import { RISK_LEVELS } from "../constants";
import { useFeatureSignals } from "../hooks/useAnalytics";
import { useDiseases } from "../hooks/useDiseases";
import { useAvailableCountries, useForecast } from "../hooks/useForecast";
import { useHistory, usePrediction } from "../hooks/usePrediction";
import FeatureTooltip from "../components/common/FeatureTooltip";
import InfoTooltip from "../components/common/InfoTooltip";
import { attachChartResize } from "../lib/echartsResize";
import { ECHARTS_COUNTRY_NAMES } from "../lib/echartsCountries";
import { isTrainingYear } from "../lib/trainingWindow";
import { DISEASE_DEFAULTS, useUIStore } from "../store/uiStore";
import type { AvailableCountry, HistoryPoint } from "../types/api";
import type { DiseaseId, RiskLevel } from "../types/domain";

function formatFeatureValue(feature: string, value: number | null): string {
	if (value === null) return "—";
	if (/temp_c|dewpoint_c/.test(feature)) return `${value.toFixed(1)}°C`;
	if (/humidity_pct/.test(feature)) return `${value.toFixed(1)}%`;
	if (/solar_wm2/.test(feature)) return `${value.toFixed(0)} W/m²`;
	if (/precip_mm/.test(feature)) return `${value.toFixed(1)} mm`;
	if (/iso_year/.test(feature)) return String(Math.round(value));
	if (/HEMISPHERE/.test(feature)) return value === 1 ? "Có" : "Không";
	if (/iso_week_sin|iso_week_cos|_week$/.test(feature)) return value.toFixed(3);
	// Biến số ca ở thang log1p (lag/rollmean) — đổi ngược expm1 về số ca thật cho
	// người đọc hiểu, thay vì hiện giá trị log khó hình dung (2.99 → ~19 ca).
	if (/_log_(lag|rollmean)/.test(feature)) {
		return `≈ ${Math.round(Math.max(0, Math.expm1(value))).toLocaleString("vi-VN")} ca`;
	}
	// Velocity/accel là hiệu của log (tốc độ/gia tốc thay đổi), không đổi ngược
	// về số ca được — giữ dạng thập phân, có dấu để biết đang tăng hay giảm.
	if (/_log_(velocity|accel)/.test(feature)) {
		return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
	}
	return value.toFixed(3);
}

type Period = { year: number; week: number };

// Cửa sổ ~52 tuần LỊCH kết thúc tại tuần as_of đã áp dụng (không phải tuần mới
// nhất). Dùng ordinal (năm*53+tuần): giữ các tuần trong [as_of-51, as_of], nhờ
// vậy khi user đổi filter thì đường xu hướng dịch theo, và không bị dán đuôi năm
// cũ vào (flu thiếu data 2020-2025). Dùng chung cho biểu đồ và nhãn tiêu đề để
// khoảng hiển thị luôn khớp với đường vẽ.
function sliceTrendWindow(points: HistoryPoint[], asOf: Period): HistoryPoint[] {
	const ordinal = (year: number, week: number) => year * 53 + week;
	const end = ordinal(asOf.year, asOf.week);
	const start = end - 51;
	return points
		.filter((p) => {
			const o = ordinal(p.iso_year, p.iso_week);
			return o >= start && o <= end;
		})
		.slice(-52);
}

function weekLabel(year: number, week: number) {
	return `Tuần ${String(week).padStart(2, "0")}/${year}`;
}

function getLatestPeriod(
	disease: DiseaseId,
	latestYear: number | null,
	latestWeek: number | null,
	availableCountry: AvailableCountry | undefined,
) {
	const fallback = DISEASE_DEFAULTS[disease];
	return {
		year: availableCountry?.latest_year ?? latestYear ?? fallback.year,
		week: availableCountry?.latest_week ?? latestWeek ?? fallback.week,
	};
}

function getWeekRange(year: number, latest: Period) {
	return { min: 1, max: year === latest.year ? latest.week : 52 };
}

function toRiskLevel(raw: string | null | undefined): RiskLevel {
	const normalized = raw?.toLowerCase() ?? "";
	if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
	return "none";
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null): string {
	return value === null ? "—" : `${value.toFixed(1)}%`;
}

function modelConfidence(r2: number | null) {
	if (r2 === null) {
		return { label: "Chưa có dữ liệu", color: "var(--color-text-3)" };
	}
	if (r2 >= 0.8) {
		return { label: "Cao", color: "var(--color-risk-low)" };
	}
	if (r2 >= 0.5) {
		return { label: "Trung bình", color: "var(--color-risk-med)" };
	}
	return { label: "Thấp", color: "var(--color-risk-high)" };
}
function TrendChart({
	points,
	disease,
	asOf,
}: {
	points: HistoryPoint[];
	disease: "flu" | "dengue";
	asOf: Period;
}) {
	const elRef = useRef<HTMLDivElement>(null);
	const color = disease === "flu" ? "#2563eb" : "#f59e0b";
	const series = useMemo(() => {
		const slice = sliceTrendWindow(points, asOf);
		return {
			labels: slice.map((p) => weekLabel(p.iso_year, p.iso_week)),
			values: slice.map((p) => p.predicted_cases ?? p.actual_cases ?? null),
		};
	}, [points, asOf.year, asOf.week]);

	useEffect(() => {
		if (!elRef.current) return;
		const ch = echarts.init(elRef.current);
		const data = series.values;
		const weeks = series.labels;

		ch.setOption({
			backgroundColor: "transparent",
			grid: { top: 16, right: 16, bottom: 32, left: 48 },
			tooltip: {
				trigger: "axis",
				backgroundColor: "#ffffff",
				borderColor: "#cbd5e1",
				textStyle: { color: "#1e293b", fontSize: 11 },
				formatter: (p: { name: string; value: number }[]) =>
					`${p[0].name}: <b>${p[0].value ?? "—"}</b> cases`,
			},
			xAxis: {
				type: "category",
				data: weeks,
				axisLine: { lineStyle: { color: "#cbd5e1" } },
				axisLabel: { color: "#1e293b", fontSize: 11, interval: 7 },
				splitLine: { show: false },
			},
			yAxis: {
				type: "value",
				min: 0,
				axisLine: { show: false },
				axisLabel: { color: "#1e293b", fontSize: 11 },
				splitLine: { lineStyle: { color: "#e5eaf1", type: "dashed" } },
			},
			series: [
				{
					type: "line",
					data,
					smooth: true,
					symbol: "none",
					lineStyle: { color, width: 3 },
					areaStyle: {
						color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
							{ offset: 0, color: color.replace(")", ",0.25)").replace("rgb", "rgba") },
							{ offset: 1, color: "rgba(0,0,0,0)" },
						]),
					},
				},
			],
		});

		return attachChartResize(elRef.current, ch);
	}, [series, disease, color]);

	return <div ref={elRef} className="w-full h-[220px]" />;
}

export default function DiseaseDetailPage() {
	const { iso3 } = useParams<{ iso3: string }>();
	const navigate = useNavigate();

	const {
		disease,
		year: uiYear,
		week: uiWeek,
		latestYear,
		latestWeek,
		setYear,
		setWeek,
		setSelectedIso3,
	} = useUIStore();
	const { getDisease } = useDiseases();
	const { available } = useAvailableCountries(disease);
	const availableCountry = useMemo(
		() => available?.countries.find((country) => country.iso3 === iso3?.toUpperCase()),
		[available, iso3],
	);

	const [activePeriod, setActivePeriod] = useState<Period>(() => ({
		year: uiYear,
		week: uiWeek,
	}));
	const prevDiseaseRef = useRef<DiseaseId>(disease);

	useEffect(() => {
		if (prevDiseaseRef.current !== disease) {
			prevDiseaseRef.current = disease;
			setActivePeriod({ year: uiYear, week: uiWeek });
		}
	}, [disease, uiYear, uiWeek]);

	// Đặt tiêu đề tab trình duyệt theo quốc gia + bệnh đang xem.
	useEffect(() => {
		const name = iso3 ? (ECHARTS_COUNTRY_NAMES[iso3.toUpperCase()] ?? iso3.toUpperCase()) : null;
		const diseaseLabel = getDisease(disease).label;
		document.title = name ? `EpiWatch · ${name} · ${diseaseLabel}` : "EpiWatch";
		return () => {
			document.title = "EpiWatch";
		};
	}, [iso3, disease, getDisease]);

	const {
		forecast,
		isLoading: forecastLoading,
		isError: forecastError,
	} = useForecast(disease, iso3, activePeriod.year, activePeriod.week);

	// week/year dùng cho display (header + prediction badge) — luôn theo tuần đã áp dụng.
	const displayWeek = forecast?.as_of_iso_week ?? activePeriod.week;
	const displayYear = forecast?.as_of_iso_year ?? activePeriod.year;
	const latestPeriod = getLatestPeriod(disease, latestYear, latestWeek, availableCountry);
	const validYears = availableCountry?.snapshot_years?.length
		? availableCountry.snapshot_years
		: [latestPeriod.year];
	const selectedWeekRange = getWeekRange(uiYear, latestPeriod);
	const historicalYears = validYears.filter((year) => year !== latestPeriod.year);
	const historicalYearsLabel = historicalYears.length
		? `${Math.min(...historicalYears)}-${Math.max(...historicalYears)}`
		: "theo dữ liệu có sẵn";
	const isFilterValid =
		validYears.includes(uiYear) &&
		uiWeek >= selectedWeekRange.min &&
		uiWeek <= selectedWeekRange.max;
	// Xu hướng 52 tuần bám theo tuần as_of đã áp dụng: lấy năm đó + năm trước
	// (đủ dữ liệu cho cửa sổ 52 tuần khi as_of nằm đầu năm), không giới hạn 52
	// dòng mới nhất — nếu không sẽ dán đuôi năm cũ vào, sai cửa sổ.
	const trendStartYear = activePeriod.year - 1;
	const trendEndYear = activePeriod.year;
	const isLatestMode = displayYear === latestPeriod.year && displayWeek === latestPeriod.week;
	const isHistoricalMode = !isLatestMode;
	const isFilterDirty = uiYear !== activePeriod.year || uiWeek !== activePeriod.week;
	const applyTitle = forecastLoading
		? "Đang tải dữ liệu dự báo"
		: !isFilterValid
			? "Tuần/năm chưa nằm trong khoảng dữ liệu hợp lệ"
			: isFilterDirty
				? "Tải dữ liệu dự báo cho tuần/năm đã chọn"
				: isHistoricalMode
					? "Đang hiển thị tuần đã áp dụng"
					: "Đang hiển thị tuần mới nhất có dữ liệu dự báo";

	const applyFilter = () => {
		if (forecastLoading || !isFilterDirty || !isFilterValid) return;
		setActivePeriod({ year: uiYear, week: uiWeek });
	};

	const resetToLatest = () => {
		setYear(latestPeriod.year);
		setWeek(latestPeriod.week);
		setActivePeriod(latestPeriod);
	};
	if (!iso3) {
		return (
			<div className="flex-1 grid place-items-center bg-[var(--color-bg)]">
				<div className="max-w-[420px] light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-6 text-center">
					<div className="text-sm font-semibold text-[var(--color-text-1)]">Chưa chọn quốc gia</div>
					<div className="mt-2 text-xs text-[var(--color-text-3)]">
						Trang này chỉ hiển thị khi bạn chọn một quốc gia từ bản đồ hoặc danh sách cảnh báo.
					</div>
					<button
						onClick={() => navigate("/")}
						className="mt-4 h-[32px] px-4 rounded-md text-xs font-semibold border border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-1)] hover:border-[var(--color-text-2)] transition-colors"
					>
						Quay lại bản đồ
					</button>
				</div>
			</div>
		);
	}

	const countryName = ECHARTS_COUNTRY_NAMES[iso3] ?? iso3;
	const d = getDisease(disease);
	const { prediction, isLoading: predictionLoading } = usePrediction(
		disease,
		iso3,
		displayYear,
		displayWeek,
	);
	const {
		history,
		isLoading: historyLoading,
		isError: historyError,
	} = useHistory(disease, iso3, trendStartYear, trendEndYear);
	// Khoảng thời gian thực tế của biểu đồ xu hướng — lấy từ cùng cửa sổ với đường
	// vẽ để tiêu đề khớp data (vd 2026 thiếu 2025 nên bắt đầu ở tuần 02/2026).
	const trendWindowPts = useMemo(
		() => sliceTrendWindow(history?.points ?? [], activePeriod),
		[history, activePeriod],
	);
	const trendRangeLabel = trendWindowPts.length
		? `${weekLabel(trendWindowPts[0].iso_year, trendWindowPts[0].iso_week)} – ${weekLabel(
				trendWindowPts[trendWindowPts.length - 1].iso_year,
				trendWindowPts[trendWindowPts.length - 1].iso_week,
			)}`
		: null;
	// Lịch sử đầy đủ 2010-2019 (không giới hạn 52 tuần) cho heatmap mùa vụ.
	const {
		history: seasonalHistory,
		isLoading: seasonalLoading,
		isError: seasonalError,
	} = useHistory(disease, iso3, 2010, 2019);
	const riskLevel = toRiskLevel(prediction?.risk_level);
	const riskDef = RISK_LEVELS[riskLevel];
	const riskLabel = riskDef.label;
	const predictedCases = prediction?.predicted_cases ?? null;
	const riskProbability =
		prediction?.risk_probability == null ? null : clampPercent(prediction.risk_probability * 100);
	const riskProbabilityLabel = formatPercent(riskProbability);
	const oneWeekR2 = forecast?.points.find((point) => point.horizon === 1)?.r2_cv ?? null;
	const confidence = modelConfidence(oneWeekR2);
	const modelConfidenceLabel = oneWeekR2 !== null ? `${(oneWeekR2 * 100).toFixed(1)}%` : "—";
	const predictedCasesLabel =
		predictedCases !== null ? Math.round(predictedCases).toLocaleString("vi-VN") : "—";
	const {
		signals: signalsData,
		isLoading: signalsLoading,
		isError: signalsError,
	} = useFeatureSignals(disease, iso3, displayYear, displayWeek);
	const topSignals = useMemo(
		() => (signalsData?.signals ?? []).slice(0, 8),
		[signalsData],
	);

	return (
		<div className="flex-1 bg-[var(--color-bg)] px-6 md:px-10 lg:px-14 py-6">
			<div className="max-w-[1180px] mx-auto flex flex-col gap-5">
				<div className="flex items-start justify-between gap-4 flex-wrap">
					<div className="flex flex-col gap-1.5">
						<button
							onClick={() => navigate("/")}
							className="self-start text-[var(--color-text-3)] hover:text-[var(--color-text-1)] text-xs"
						>
							← Quay lại bản đồ
						</button>
						<h1 className="text-2xl font-semibold text-[var(--color-text-1)] leading-tight">
							Kết quả phân tích — {countryName}
						</h1>
						<p className="text-sm text-[var(--color-text-3)]">
							{d.label} · Tuần {String(displayWeek).padStart(2, "0")} · Năm {displayYear}
						</p>
					</div>
					<div className="flex flex-col items-end gap-1">
						<div
							className="px-4 py-2 rounded-lg text-sm font-bold text-white"
							style={{ backgroundColor: riskDef.color }}
						>
							{predictionLoading ? "Đang tải…" : riskLabel}
						</div>
						<div className="text-[11px] font-medium text-[var(--color-text-2)] tabular-nums">
							Khả năng cảnh báo Cao: {predictionLoading ? "…" : riskProbabilityLabel}
						</div>
					</div>
				</div>

				<div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5 items-start">
				<aside className="flex flex-col gap-3 lg:sticky lg:top-[56px]">
					<div className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-4 flex flex-col gap-2.5">
						<div className="dashboard-section-title">Vị trí trên bản đồ</div>
						<CountryMiniMap
							iso3={iso3}
							riskColor={riskDef.color}
							onClick={() => {
								setSelectedIso3(iso3.toUpperCase());
								navigate("/");
							}}
						/>
						<p className="text-[11px] text-[var(--color-text-3)] leading-relaxed">
							Bấm vào bản đồ để xem quốc gia này trên bản đồ rủi ro toàn cầu.
						</p>
					</div>
				</aside>

				<div className="flex flex-col gap-5 min-w-0">
				<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
					{[
						{
							label: "Số ca dự báo",
							value: predictionLoading ? "…" : predictedCasesLabel,
							sub: `Tuần ${String(displayWeek).padStart(2, "0")} · Năm ${displayYear}`,
						},
						{
							label: "Nhóm rủi ro",
							value: predictionLoading ? "…" : riskLabel,
							sub:
								riskLevel === "high"
									? "Cần ưu tiên theo dõi và chuẩn bị ứng phó trong tuần này."
									: "Mức cảnh báo hiện tại cho quốc gia trong tuần này.",
							color: riskDef.color,
						},
						{
							label: "Khả năng cảnh báo Cao",
							value: predictionLoading ? "…" : riskProbabilityLabel,
							sub: "Chỉ số càng cao thì cảnh báo Cao càng đáng chú ý; không phải % dân số mắc bệnh.",
							color: riskDef.color,
						},
						{
							label: "Độ tin cậy dự báo",
							value: forecastLoading ? "…" : modelConfidenceLabel,
							sub: `So với dữ liệu cũ: ${confidence.label}`,
							color: confidence.color,
							info: "Độ tin cậy lấy từ R² (hệ số xác định) của mô hình theo walk-forward CV: đo mô hình giải thích được bao nhiêu phần dao động số ca thực tế. Thang 0–100%, càng cao càng đáng tin. Trên 80% là cao, 50–80% trung bình, dưới 50% là thấp.",
						},
					].map((stat) => (
						<div
							key={stat.label}
							className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-4"
						>
							<div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[var(--color-text-3)] mb-1">
								{stat.label}
								{"info" in stat && stat.info && <InfoTooltip text={stat.info} />}
							</div>
							<div
								className="text-2xl font-semibold text-[var(--color-text-1)]"
								style={{ color: stat.color }}
							>
								{stat.value}
							</div>
							{stat.sub && (
								<div className="text-xs leading-relaxed text-[var(--color-text-3)] mt-1">
									{stat.sub}
								</div>
							)}
						</div>
					))}
				</div>

				<div className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-5">
					{/* Header: title + as-of label + shared week filter */}
					<div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
						<div>
							<div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-1)]">
								Dự báo 4 tuần · {d.label}
								<InfoTooltip text="Đường đậm là số ca dự báo cho 4 tuần kế tiếp. Dải mờ quanh đường là khoảng tin cậy ±RMSE (sai số toàn phương trung bình của mô hình theo walk-forward CV), đã quy đổi ngược từ thang log1p về số ca. Dải càng hẹp thì dự báo càng chắc." />
								{isTrainingYear(displayYear) ? (
									<span
										className="ml-2 text-[10px] font-normal text-amber-400"
										title="Năm 2010-2019 nằm trong tập huấn luyện — kết quả in-sample, chỉ để đối chiếu"
									>
										● backtest (đã huấn luyện)
									</span>
								) : isLatestMode ? (
									<span className="ml-2 text-[10px] font-normal text-emerald-400">● mới nhất</span>
								) : (
									<span className="ml-2 text-[10px] font-normal text-sky-400">● dự báo</span>
								)}
							</div>
							{forecast && (
								<div className="mt-0.5 text-[11px] text-[var(--color-text-3)]">
									Từ Tuần {String(forecast.as_of_iso_week).padStart(2, "0")} · Năm{" "}
									{forecast.as_of_iso_year} → Tuần{" "}
									{String(forecast.points[0]?.target_iso_week).padStart(2, "0")}–
									{String(forecast.points[3]?.target_iso_week).padStart(2, "0")} · Năm{" "}
									{forecast.points[3]?.target_iso_year}
								</div>
							)}
						</div>
						<div className="flex flex-col items-end gap-1">
							<div className="flex items-end gap-1.5 text-[11px]">
								<label className="flex flex-col gap-1 text-[var(--color-text-3)]">
									Tuần
									<input
										type="number"
										placeholder="Tuần"
										min={selectedWeekRange.min}
										max={selectedWeekRange.max}
										value={uiWeek}
										onChange={(event) => setWeek(Number(event.target.value))}
										onKeyDown={(event) => event.key === "Enter" && applyFilter()}
										className="w-[58px] bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-1)] text-center [appearance:textfield] outline-none"
									/>
								</label>
								<label className="flex flex-col gap-1 text-[var(--color-text-3)]">
									Năm
									<input
										type="number"
										placeholder="Năm"
										min={Math.min(...validYears)}
										max={Math.max(...validYears)}
										value={uiYear}
										onChange={(event) => setYear(Number(event.target.value))}
										onKeyDown={(event) => event.key === "Enter" && applyFilter()}
										className="w-[72px] bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-1)] text-center [appearance:textfield] outline-none"
									/>
								</label>
								<button
									onClick={applyFilter}
									disabled={forecastLoading || !isFilterDirty || !isFilterValid}
									title={applyTitle}
									className="px-2.5 py-1 rounded bg-[var(--color-primary)] text-white hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 transition-opacity"
								>
									Áp dụng
								</button>
								{isHistoricalMode && (
									<button
										onClick={resetToLatest}
										disabled={forecastLoading}
										title="Quay về tuần mới nhất"
										className="px-2.5 py-1 rounded bg-[var(--color-surface-3)] text-[var(--color-text-3)] hover:text-[var(--color-text-1)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
									>
										Mới nhất
									</button>
								)}
							</div>
							<div className="text-[10px] text-[var(--color-text-3)]">
								Hợp lệ: kiểm thử quá khứ {historicalYearsLabel} hoặc mới nhất Năm {latestPeriod.year}, Tuần {String(latestPeriod.week).padStart(2, "0")}
							</div>
						</div>
					</div>

					{forecastLoading && (
						<div className="h-[260px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Đang tải dự báo…
						</div>
					)}
					{!forecastLoading && forecastError && (
						<div className="h-[260px] grid place-items-center text-center text-amber-400 text-xs gap-1">
							<div>
								Không có dữ liệu đầu vào cho Tuần{" "}
								{String(displayWeek).padStart(2, "0")}, Năm{" "}
								{displayYear}
							</div>
							<div className="text-[var(--color-text-3)]">
								{isHistoricalMode
									? "Thử tuần/năm kiểm thử quá khứ khác"
									: "Cần cập nhật dữ liệu dự báo trước"}
							</div>
						</div>
					)}
					{!forecastLoading && !forecastError && forecast && forecast.points.length > 0 && (
						<ForecastChart points={forecast.points} disease={disease} />
					)}
				</div>

				<div className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-5">
					<div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-1)] mb-1">
						Quy luật mùa vụ · {d.label}
						<InfoTooltip text="Mỗi hàng là một năm trong giai đoạn huấn luyện, mỗi cột là một tuần ISO trong năm. Ô càng đậm (đỏ) thì số ca thực tế tuần đó càng cao. Các vệt đậm xếp thẳng cột qua nhiều năm cho thấy bệnh bùng phát lặp lại đúng mùa hằng năm." />
					</div>
					<div className="mb-4 text-[11px] text-[var(--color-text-3)]">
						Số ca thực tế theo tuần × năm trong giai đoạn huấn luyện — cột đậm lặp lại = đỉnh mùa hằng năm
					</div>
					{seasonalLoading && (
						<div className="h-[260px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Đang tải lịch sử mùa vụ…
						</div>
					)}
					{!seasonalLoading && seasonalError && (
						<div className="h-[260px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Chưa có dữ liệu lịch sử 2010-2019 từ API.
						</div>
					)}
					{!seasonalLoading && !seasonalError && seasonalHistory && (
						<SeasonalHeatmap points={seasonalHistory.points} disease={disease} />
					)}
				</div>

				<div className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-5">
					<div className="text-[13px] font-semibold text-[var(--color-text-1)] mb-4">
						Xu hướng 1 năm · {d.label}
						{trendRangeLabel && (
							<span className="ml-1 font-normal text-[var(--color-text-3)]">
								({trendRangeLabel})
							</span>
						)}
					</div>
					{historyLoading && (
						<div className="h-[220px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Đang tải lịch sử…
						</div>
					)}
					{!historyLoading && historyError && (
						<div className="h-[220px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Chưa có dữ liệu xu hướng từ API.
						</div>
					)}
					{!historyLoading && !historyError && history && history.points.length > 0 && (
						<TrendChart points={history.points} disease={disease} asOf={activePeriod} />
					)}
				</div>

				<div className="light-card bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-[0_2px_8px_rgba(15,23,42,0.08)] p-5">
					<div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-1)] mb-1">
						Yếu tố tác động tới dự báo · {d.label}
						<InfoTooltip text="Mô hình dự báo số ca dựa trên nhiều yếu tố: số ca các tuần trước và thời tiết ở các độ trễ khác nhau. Bảng này liệt kê các yếu tố quan trọng nhất, kèm giá trị của chúng tại tuần đang xem và chiều tác động lên dự báo." />
					</div>
					<div className="text-[11px] text-[var(--color-text-3)]">
						{countryName}, Tuần {String(displayWeek).padStart(2, "0")} · Năm {displayYear}
					</div>
					<div className="mb-4 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-3)]">
						<span><span className="text-rose-500 font-bold">▲</span>/<span className="text-emerald-500 font-bold">▼</span> giá trị tuần này đẩy dự báo tăng / giảm</span>
						<span>Thanh % = mức độ quan trọng của yếu tố trong mô hình (chung, không đổi theo tuần)</span>
					</div>
					{signalsLoading && (
						<div className="h-[200px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Đang tải tín hiệu…
						</div>
					)}
					{!signalsLoading && signalsError && (
						<div className="h-[200px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Chưa có dữ liệu tín hiệu cho tuần này.
						</div>
					)}
					{!signalsLoading && !signalsError && topSignals.length > 0 && (
						<div className="space-y-3">
							{topSignals.map((signal) => (
								<div key={signal.feature} className="flex items-start gap-2">
									<span
										className={`mt-0.5 text-xs font-bold shrink-0 w-4 text-center ${
											signal.direction === "up"
												? "text-rose-500"
												: signal.direction === "down"
													? "text-emerald-500"
													: "text-[var(--color-text-3)]"
										}`}
										title={
											signal.direction === "up"
												? "Đẩy dự báo số ca tăng"
												: signal.direction === "down"
													? "Đẩy dự báo số ca giảm"
													: "Ảnh hưởng không rõ chiều"
										}
									>
										{signal.direction === "up" ? "▲" : signal.direction === "down" ? "▼" : "—"}
									</span>
									<div className="flex-1 min-w-0">
										<div className="flex items-baseline justify-between gap-2 mb-1">
											<div className="text-[11px] min-w-0">
												<FeatureTooltip metadata={signal} />
											</div>
											<span className="text-[11px] font-mono tabular-nums text-[var(--color-text-1)] shrink-0">
												{formatFeatureValue(signal.feature, signal.value)}
											</span>
										</div>
										<div
											className="relative h-5 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)]"
											role="progressbar"
											aria-label={`Mức ảnh hưởng: ${(signal.importance * 100).toFixed(1)}%`}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={Number((signal.importance * 100).toFixed(1))}
										>
											<div
												className="absolute inset-y-0 left-0 rounded-md transition-[width] duration-300"
												style={{
													width: `${signal.importance * 100}%`,
													backgroundColor: d.color,
												}}
											/>
											<div className="absolute inset-0 grid place-items-center text-[9px] font-bold tabular-nums text-[var(--color-text-1)] [text-shadow:0_0_4px_rgba(255,255,255,0.7)]">
												{(signal.importance * 100).toFixed(1)}%
											</div>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
					{!signalsLoading && !signalsError && topSignals.length === 0 && (
						<div className="h-[200px] grid place-items-center text-[var(--color-text-3)] text-xs">
							Chưa có dữ liệu tín hiệu cho tuần này.
						</div>
					)}
				</div>
				</div>
			</div>
		</div>
		</div>
	);
}
