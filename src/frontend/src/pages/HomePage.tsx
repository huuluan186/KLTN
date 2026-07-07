import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import AlertsSidebar from "../components/alerts/AlertsSidebar";
import MapLegend from "../components/map/MapLegend";
import MapThemeToggle from "../components/map/MapThemeToggle";
import WorldMap from "../components/map/WorldMap";
import { MAP_THEME_STORAGE_KEY, type MapTheme } from "../components/map/mapTheme";
import RiskMapSidebar from "../components/sidebar/RiskMapSidebar";
import InfoTooltip from "../components/common/InfoTooltip";
import { RISK_LEVELS } from "../constants";
import { useCountries } from "../hooks/useCountries";
import { useDiseases } from "../hooks/useDiseases";
import { useForecast } from "../hooks/useForecast";
import { usePrediction } from "../hooks/usePrediction";
import { useLatestRiskMap, useRiskMap, useRiskMapPeriods } from "../hooks/useRiskMap";
import { ECHARTS_COUNTRY_NAMES, ISO3_BY_ECHARTS_NAME } from "../lib/echartsCountries";
import { isTrainingYear } from "../lib/trainingWindow";
import { useUIStore } from "../store/uiStore";
import type { RiskEntry } from "../types/api";
import type { DiseaseId, RiskLevel } from "../types/domain";

type Applied = { year: number; week: number } | null;
function normalizeRisk(raw: string | null | undefined): RiskLevel {
	const normalized = raw?.toLowerCase() ?? "";
	if (normalized === "high" || normalized === "medium" || normalized === "low") {
		return normalized;
	}
	return "none";
}

export default function HomePage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const {
		disease,
		setDisease,
		year,
		setYear,
		week,
		setWeek,
		regions,
		toggleRegion,
		selectedIso3,
		setSelectedIso3,
		riskLevels,
		toggleRiskLevel,
		setLatest,
	} = useUIStore();

	const [isRightOpen, setIsRightOpen] = useState(true);
	const [isLeftOpen, setIsLeftOpen] = useState(true);
	const [isCountrySummaryOpen, setIsCountrySummaryOpen] = useState(true);
	const [resultAttention, setResultAttention] = useState(false);
	const [mapTheme, setMapTheme] = useState<MapTheme>(() => {
		const saved = window.localStorage.getItem(MAP_THEME_STORAGE_KEY);
		return saved === "light" ? "light" : "dark";
	});

	// applied = null → dùng latest (mặc định); != null → dùng backtest
	const [applied, setApplied] = useState<Applied>(null);
	const { getDisease } = useDiseases();
	const activeDisease = getDisease(disease);
	const isHistorical = applied !== null;

	useEffect(() => {
		window.localStorage.setItem(MAP_THEME_STORAGE_KEY, mapTheme);
	}, [mapTheme]);

	useEffect(() => {
		if (selectedIso3) setIsCountrySummaryOpen(true);
	}, [selectedIso3]);

	// Khi user đổi disease, reset applied về null (latest mode) để tránh
	// hiển thị bản đồ flu năm cũ đè lên dengue
	const prevDiseaseRef = useRef(disease);
	useEffect(() => {
		if (prevDiseaseRef.current !== disease) {
			prevDiseaseRef.current = disease;
			setApplied(null);
		}
	}, [disease]);

	// Ref để track xem đã sync year/week cho disease này chưa
	// Tránh effect ghi đè khi user bấm mũi tên đổi tuần
	const syncedForDiseaseRef = useRef<DiseaseId | null>(null);

	const riskPeriods = useRiskMapPeriods(disease);

	// Latest mode (always fetch — dùng làm default + fallback)
	const latest = useLatestRiskMap(disease, { enabled: !isHistorical });

	// Backtest mode (chỉ fetch khi user apply picker)
	const historical = useRiskMap(disease, applied?.year ?? 2019, applied?.week ?? 1, {
		enabled: isHistorical,
	});

	const active = isHistorical ? historical : latest;
	const entries = active.entries;
	const latestYear = riskPeriods.periods?.latest_year ?? latest.meta?.year;
	const latestWeek = riskPeriods.periods?.latest_week ?? latest.meta?.week;
	const activeYear = isHistorical ? applied!.year : (latestYear ?? year);
	const activeWeek = isHistorical ? applied!.week : (latestWeek ?? week);
	// Nhãn header phản ánh nguồn dữ liệu (methodology), KHÔNG phải chế độ ghim tuần:
	// - Năm 2010-2019 → in-sample, model đã thấy lúc train → BACKTEST (cảnh báo).
	// - Năm out-of-sample (2022, 2026...) → dự báo thật; nếu đang bám tuần mới nhất
	//   thì là MỚI NHẤT, nếu ghim tuần cũ thì là DỰ BÁO.
	const isInSample = isTrainingYear(activeYear);

	// Thu hút sự chú ý vào sidebar kết quả khi request filter hoàn tất.
	const wasFetchingRef = useRef(false);
	useEffect(() => {
		if (active.isFetching) {
			wasFetchingRef.current = true;
			setIsRightOpen(true);
			setResultAttention(false);
			return;
		}
		if (!wasFetchingRef.current) return;

		wasFetchingRef.current = false;
		setResultAttention(true);
		const timer = window.setTimeout(() => setResultAttention(false), 2200);
		return () => window.clearTimeout(timer);
	}, [active.isFetching]);

	// Đồng bộ year/week của picker với latest.meta CHỈ MỘT LẦN cho mỗi disease.
	// Sau khi sync xong, user toàn quyền đổi tuần qua picker — effect KHÔNG ghi đè.
	// (Trước đây sync mỗi render → user bấm mũi tên xong bị revert ngay)
	// Đồng thời cập nhật store.latestYear/latestWeek mỗi khi API trả về,
	// để TopNav luôn phản ánh tuần mới nhất thực sự có data.
	useEffect(() => {
		if (latestYear !== undefined && latestWeek !== undefined) {
			setLatest(latestYear, latestWeek);
			if (syncedForDiseaseRef.current !== disease) {
				syncedForDiseaseRef.current = disease;
				if (latestYear !== year) setYear(latestYear);
				if (latestWeek !== week) setWeek(latestWeek);
			}
		}
	}, [disease, latestYear, latestWeek, year, week, setYear, setWeek, setLatest]);

	const isDirty = !isHistorical
		? year !== (latestYear ?? year) || week !== (latestWeek ?? week)
		: year !== applied!.year || week !== applied!.week;

	const { countries } = useCountries();
	const countryIso2Map = useMemo(() => {
		const map = new Map<string, string>();
		countries.forEach((c) => {
			if (c.iso2) map.set(c.iso3, c.iso2);
		});
		return map;
	}, [countries]);
	const countryRegionMap = useMemo(() => {
		const map = new Map<string, string>();
		countries.forEach((c) => {
			if (c.who_region) map.set(c.iso3, c.who_region);
		});
		return map;
	}, [countries]);
	const selectedCountry = useMemo(
		() => (selectedIso3 ? (countries.find((c) => c.iso3 === selectedIso3) ?? null) : null),
		[countries, selectedIso3],
	);
	const entriesWithRegion = useMemo<RiskEntry[]>(() => {
		return entries.map((e) => {
			if (e.whoRegion) return e;
			const region = countryRegionMap.get(e.iso3) ?? null;
			return { ...e, whoRegion: region };
		});
	}, [entries, countryRegionMap]);
	const selectedRiskEntry = useMemo(
		() => (selectedIso3 ? (entriesWithRegion.find((e) => e.iso3 === selectedIso3) ?? null) : null),
		[entriesWithRegion, selectedIso3],
	);

	const filteredEntries = useMemo(() => {
		let out = entriesWithRegion;
		if (regions.length) {
			out = out.filter((e) => e.whoRegion && regions.includes(e.whoRegion));
		}
		if (riskLevels.length) {
			out = out.filter((e) => e.risk && riskLevels.includes(e.risk));
		}
		return out;
	}, [entriesWithRegion, regions, riskLevels]);

	// Sidebar chỉ lấy mức độ tuần đang xem; dự báo chi tiết nằm ở trang quốc gia.
	const { prediction, isLoading: predictionLoading } = usePrediction(
		disease,
		selectedIso3 ?? undefined,
		activeYear,
		activeWeek,
	);
	const countryForecastQuery = useForecast(
		disease,
		selectedIso3 ?? undefined,
		activeYear,
		activeWeek,
		{ enabled: Boolean(selectedIso3) },
	);
	const countryForecast = countryForecastQuery.forecast;
	const countryForecastLoading = countryForecastQuery.isLoading;
	const countryForecastError = countryForecastQuery.isError;
	const selectedName = selectedIso3
		? (selectedCountry?.country_name ?? ECHARTS_COUNTRY_NAMES[selectedIso3] ?? selectedIso3)
		: null;
	const riskKey = (() => {
		const raw = normalizeRisk(prediction?.risk_level);
		if (raw !== "none") return raw;
		const fallback = selectedRiskEntry?.risk;
		if (fallback === "high" || fallback === "medium" || fallback === "low") return fallback;
		return "none";
	})() as keyof typeof RISK_LEVELS;
	const riskLabel = RISK_LEVELS[riskKey].label;
	const riskColor = RISK_LEVELS[riskKey].color;
	const riskDisplayLoading = predictionLoading && riskKey === "none";

	const clearDetailQueryCache = () => {
		if (!selectedIso3) return;
		queryClient.removeQueries({ queryKey: ["prediction", disease, selectedIso3], exact: false });
		queryClient.removeQueries({ queryKey: ["forecast", disease, selectedIso3], exact: false });
		queryClient.removeQueries({ queryKey: ["history", disease, selectedIso3], exact: false });
		queryClient.invalidateQueries({
			queryKey: ["prediction", disease, selectedIso3],
			exact: false,
		});
		queryClient.invalidateQueries({ queryKey: ["forecast", disease, selectedIso3], exact: false });
		queryClient.invalidateQueries({ queryKey: ["history", disease, selectedIso3], exact: false });
	};

	const applyHistorical = () => {
		clearDetailQueryCache();
		setIsRightOpen(true);
		setResultAttention(false);
		setApplied({ year, week });
	};
	const resetToLatest = () => {
		clearDetailQueryCache();
		setIsRightOpen(true);
		setResultAttention(false);
		setApplied(null);
		if (latestYear !== undefined && latestWeek !== undefined) {
			setYear(latestYear);
			setWeek(latestWeek);
		}
	};

	return (
		<div className="flex flex-1 h-full min-h-0 overflow-hidden">
			<RiskMapSidebar
				disease={disease}
				setDisease={setDisease}
				year={year}
				setYear={setYear}
				week={week}
				setWeek={setWeek}
				activeYear={activeYear}
				activeWeek={activeWeek}
				latestYear={latestYear}
				latestWeek={latestWeek}
				periods={riskPeriods.periods?.periods}
				regions={regions}
				toggleRegion={toggleRegion}
				entries={filteredEntries}
				regionEntries={entriesWithRegion}
				totalReportingCountries={entriesWithRegion.filter((entry) => entry.risk !== "none").length}
				onApply={applyHistorical}
				onResetLatest={resetToLatest}
				isApplying={active.isFetching}
				isDirty={isDirty}
				isHistorical={isHistorical}
				riskLevels={riskLevels}
				toggleRiskLevel={toggleRiskLevel}
				isOpen={isLeftOpen}
				onToggle={() => setIsLeftOpen((v) => !v)}
			/>

			<div className="flex-1 min-h-0 bg-[var(--color-bg)] overflow-hidden flex flex-col">
				<div className="px-5 py-3.5 border-b border-[var(--color-border)]">
					<div className="flex items-center justify-between">
						<h2 className="m-0 text-[15px] font-semibold">
							Bản đồ rủi ro toàn cầu · {activeDisease.label}
						</h2>
						<div className="flex items-center gap-2 text-xs text-[var(--color-text-3)]">
							{isInSample ? (
								<span
									className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-semibold tracking-wide"
									title="Năm nằm trong tập huấn luyện 2010-2019 — kết quả in-sample, cao hơn năng lực thực trên dữ liệu mới"
								>
									BACKTEST
								</span>
							) : isHistorical ? (
								<span
									className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 font-semibold tracking-wide"
									title="Dự báo out-of-sample cho một tuần đã chọn (ngoài tập huấn luyện)"
								>
									DỰ BÁO
								</span>
							) : (
								<span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-semibold tracking-wide">
									MỚI NHẤT
								</span>
							)}
							<span className="grid min-w-[72px] gap-0.5 text-right leading-tight">
								<span className="text-[var(--color-text-1)]">
									Tuần {String(activeWeek).padStart(2, "0")}
								</span>
								<span>Năm {activeYear}</span>
							</span>
							<MapThemeToggle theme={mapTheme} onChange={setMapTheme} />
							{active.isFetching && (
								<span className="text-[var(--color-text-3)] animate-pulse">· đang cập nhật</span>
							)}
						</div>
					</div>
					<div className="mt-1 text-xs text-[var(--color-text-2)]">
						{regions.length ? `Vùng: ${regions.join(", ")}` : "Tất cả vùng"} ·{" "}
						{filteredEntries.length} quốc gia
						{active.isError && <span className="ml-2 text-[var(--color-risk-high)]">Lỗi API</span>}
					</div>
				</div>

				<div className="flex-1 min-h-0 relative">
					{active.isLoading && (
						<div className="absolute inset-0 grid place-items-center bg-[var(--color-bg)]/50 z-10 backdrop-blur-sm">
							<div className="text-[var(--color-text-3)] text-xs animate-pulse">
								Đang tải bản đồ…
							</div>
						</div>
					)}
					<WorldMap
						entries={filteredEntries}
						theme={mapTheme}
						onCountrySelect={(echartsName) => {
							const iso3 = ISO3_BY_ECHARTS_NAME[echartsName];
							if (!iso3) return;
							setSelectedIso3(iso3);
						}}
					/>
					<MapLegend theme={mapTheme} />
				</div>
			</div>

			<aside
				className={`relative hidden lg:flex shrink-0 border-l-2 bg-[var(--color-focus-panel)] text-slate-100 flex-col min-h-0 transition-all shadow-xl ${
					active.isFetching
						? "border-amber-300 ring-2 ring-inset ring-amber-300/45"
						: resultAttention
							? "epiwatch-result-attention border-[var(--color-focus-accent)]"
							: "border-[var(--color-focus-border)]"
				} ${isRightOpen ? "w-[380px]" : "w-[44px]"}`}
			>
				<div className="flex items-center justify-between px-3 py-3 border-b border-[var(--color-focus-border)] bg-[var(--color-focus-raised)]">
					{isRightOpen && (
						<div>
							<div className="flex items-center gap-2">
								<span
									className={`w-1.5 h-1.5 rounded-full ${
										active.isFetching
											? "bg-amber-300 animate-pulse"
											: "bg-[var(--color-focus-accent)]"
									}`}
								/>
								<div className="dashboard-panel-title">Kết quả phân tích</div>
							</div>
							<div className="mt-1 text-[11px] font-medium text-slate-100">
								{active.isFetching
									? "Đang cập nhật dữ liệu từ API..."
									: `${activeDisease.label} · Tuần ${String(activeWeek).padStart(2, "0")} · ${activeYear}`}
							</div>
						</div>
					)}
					<button
						onClick={() => setIsRightOpen((v) => !v)}
						aria-label={isRightOpen ? "Thu gọn panel" : "Mở rộng panel"}
						className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel-inset)] text-white hover:border-white hover:bg-[var(--color-panel-raised)] transition-colors"
					>
						{isRightOpen ? "›" : "‹"}
					</button>
				</div>

				{!isRightOpen && (
					<div className="flex-1 grid place-items-center text-[10px] font-bold text-slate-200 tracking-[0.2em] rotate-90">
						CHI TIẾT
					</div>
				)}

				{isRightOpen && (
					<div className="mx-3 mt-3 mb-3 rounded-xl border border-[var(--color-focus-border)] bg-[var(--color-focus-raised)] shadow-md overflow-y-auto">
						{!selectedIso3 && (
							<div className="p-4 text-xs text-slate-100 space-y-2">
								<div className="font-bold text-white">Chưa chọn quốc gia</div>
								<div>Bạn có thể bấm trên bản đồ hoặc chọn từ danh sách cảnh báo.</div>
								<div className="text-[11px] text-slate-100">
									{activeDisease.label}: {activeDisease.description}
								</div>
							</div>
						)}
						{selectedIso3 && (
							<div className="flex flex-col gap-3 p-3">
								{/* Header: quốc gia + mức rủi ro */}
								<div className="flex items-start justify-between gap-2 -mx-3 -mt-3 mb-1 px-3 py-3 rounded-t-xl border-b border-[var(--color-focus-border)] bg-[var(--color-focus-raised)]">
									<div>
										<div className="dashboard-section-title mb-1">Quốc gia đang xem</div>
										<div className="text-base font-bold text-white">{selectedName}</div>
										<div className="text-[11px] font-medium text-slate-100">
											{selectedIso3} · {activeDisease.label}
										</div>
									</div>
									<div className="flex items-center gap-2">
										<div
											className="px-2.5 py-1 rounded-md text-[10px] font-bold text-white shrink-0"
											style={{ backgroundColor: riskColor }}
										>
											{riskDisplayLoading ? "…" : riskLabel}
										</div>
										<button
											onClick={() => setIsCountrySummaryOpen((open) => !open)}
											aria-label={
												isCountrySummaryOpen
													? "Thu gọn quốc gia đang xem"
													: "Mở rộng quốc gia đang xem"
											}
											className="w-7 h-7 grid place-items-center rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel-inset)] text-white hover:border-white hover:bg-[var(--color-panel)] transition-colors"
										>
											{isCountrySummaryOpen ? "˅" : "˄"}
										</button>
									</div>
								</div>

								{isCountrySummaryOpen && (
									<>
										<div className="grid grid-cols-2 gap-2">
											<div className="p-2.5 bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md">
												<div className="text-[10px] font-semibold uppercase text-slate-100">
													Mức độ rủi ro
												</div>
												<div className="mt-1">
													<span
														className="inline-flex px-2 py-1 rounded-md text-xs font-bold text-white"
														style={{ backgroundColor: riskColor }}
													>
														{riskDisplayLoading ? "Đang tải…" : riskLabel}
													</span>
												</div>
											</div>
											<div className="p-2.5 bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md">
												<div className="text-[10px] font-semibold uppercase text-slate-100">
													Tuần đang xem
												</div>
												<div className="mt-1 font-bold text-white tabular-nums leading-tight">
													<div className="text-base">
														Tuần {String(activeWeek).padStart(2, "0")}
													</div>
													<div className="mt-0.5 text-[11px] text-slate-300">Năm {activeYear}</div>
												</div>
											</div>
										</div>

										<div className="flex items-center justify-between gap-3 px-2.5 py-2 bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md text-[11px]">
											<span className="text-slate-100">Vùng WHO</span>
											<span className="font-semibold text-white">
												{selectedCountry?.who_region ?? "—"}
											</span>
										</div>

										<div className="bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md overflow-visible">
											<div className="px-2.5 py-2 border-b border-[var(--color-panel-border)] bg-[var(--color-panel)]">
												<span className="dashboard-section-title gap-1.5">
													Mức độ 4 tuần tới
													<InfoTooltip
														text="Phân loại mỗi horizon theo endemic channel Bortman 1999: so sánh số ca dự báo với dữ liệu lịch sử cùng tuần ISO của quốc gia. Thấp nếu dưới trung bình lịch sử, Trung bình nếu dưới trung bình + 2 độ lệch chuẩn, Cao nếu vượt ngưỡng đó."
														align="end"
													/>
												</span>
											</div>
											<div className="px-2.5 py-2.5">
												{countryForecastLoading && (
													<div className="text-[11px] text-slate-100 animate-pulse">
														Đang tải dự báo 4 tuần…
													</div>
												)}
												{!countryForecastLoading && countryForecastError && (
													<div className="text-[11px] text-slate-100">
														Chưa có dự báo 4 tuần cho thời điểm này.
													</div>
												)}
												{!countryForecastLoading && countryForecast && (
													<div className="grid grid-cols-2 gap-2">
														{countryForecast.points.map((point) => {
															const pointRisk = normalizeRisk(point.risk_level);
															const pointRiskDef = RISK_LEVELS[pointRisk];
															const hasRiskLevel = pointRisk !== "none";
															const predictedCases = Math.round(point.predicted_cases).toLocaleString();
															return (
																<div
																	key={point.horizon}
																	className="rounded-md border border-[var(--color-panel-border)] bg-[var(--color-focus-raised)] px-2 py-1.5"
																>
																	<div>
																		<div className="text-[10px] font-semibold text-white">
																			Tuần {String(point.target_iso_week).padStart(2, "0")}
																		</div>
																		<div className="text-[9px] text-slate-300">
																			Năm {point.target_iso_year}
																		</div>
																	</div>
																	<span
																		className="inline-block rounded px-1.5 py-0.5 text-[9px] font-bold leading-tight text-white"
																		style={{
																			backgroundColor: hasRiskLevel
																				? pointRiskDef.color
																				: "var(--color-panel-border)",
																		}}
																		title={
																			hasRiskLevel
																				? undefined
																				: "Quốc gia này chưa có đủ dữ liệu lịch sử 2010-2018 để tính ngưỡng endemic channel — không phải lỗi dự báo, chỉ là thiếu baseline để xếp mức."
																		}
																	>
																		{hasRiskLevel ? pointRiskDef.label : "Thiếu dữ liệu lịch sử"}
																	</span>
																	<div className="mt-1 text-[10px] font-semibold text-slate-100 tabular-nums">
																		Dự báo {predictedCases} ca
																	</div>
																</div>
															);
														})}
													</div>
												)}
												{!countryForecastLoading && countryForecast && (
													<div className="mt-2 text-[9px] text-slate-300">
														Phân mức theo endemic channel Bortman 1999.
													</div>
												)}
											</div>
										</div>

										<button
											onClick={() => navigate(`/country/${selectedIso3}`)}
											className="h-[36px] rounded-md text-xs font-bold border border-blue-200/50 bg-[#2563a6] text-white hover:bg-[#3074bd] transition-colors"
										>
											Xem đầy đủ chi tiết quốc gia →
										</button>
									</>
								)}
							</div>
						)}
					</div>
				)}

				{isRightOpen && (
					<AlertsSidebar
						entries={filteredEntries}
						disease={disease}
						iso2ByIso3={countryIso2Map}
						selectedIso3={selectedIso3}
						onSelect={setSelectedIso3}
					/>
				)}
			</aside>
		</div>
	);
}
