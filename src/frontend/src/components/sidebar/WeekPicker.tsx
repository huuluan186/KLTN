import type { RiskMapPeriod } from "../../types/api";
import type { DiseaseId } from "../../types/domain";
import { isTrainingYear } from "../../lib/trainingWindow";
import Icon from "../common/Icon";

interface Props {
  disease: DiseaseId;
  year: number;
  week: number;
  latestYear?: number;
  latestWeek?: number;
  periods?: RiskMapPeriod[];
  onYearChange: (y: number) => void;
  onWeekChange: (w: number) => void;
}

function buildFallbackPeriods(year: number, week: number, latestYear?: number, latestWeek?: number) {
  const fallbackYear = latestYear ?? year;
  const fallbackWeek = latestWeek ?? week;
  return [{ iso_year: fallbackYear, min_week: 1, max_week: Math.max(1, fallbackWeek) }];
}

function getSortedPeriods(
  periods: RiskMapPeriod[] | undefined,
  year: number,
  week: number,
  latestYear?: number,
  latestWeek?: number,
) {
  const source = periods?.length ? periods : buildFallbackPeriods(year, week, latestYear, latestWeek);
  return [...source].sort((a, b) => a.iso_year - b.iso_year);
}

function getLatest(periods: RiskMapPeriod[], latestYear?: number, latestWeek?: number) {
  const last = periods[periods.length - 1];
  return {
    year: latestYear ?? last.iso_year,
    week: latestWeek ?? last.max_week,
  };
}

function getRange(periods: RiskMapPeriod[], year: number, latest: { year: number; week: number }) {
  const configured = periods.find((period) => period.iso_year === year);
  const minWeek = configured?.min_week ?? 1;
  const maxWeek = configured?.max_week ?? (year === latest.year ? latest.week : 52);
  return { min: minWeek, max: year === latest.year ? Math.min(maxWeek, latest.week) : maxWeek };
}

function getHintText(periods: RiskMapPeriod[], year: number, latest: { year: number; week: number }) {
  const { min } = getRange(periods, year, latest);
  if (isTrainingYear(year)) {
    return "Backtest (2010-2019): năm đã huấn luyện, kết quả in-sample — chỉ để đối chiếu, không phản ánh năng lực trên dữ liệu mới";
  }
  if (year !== latest.year) {
    return "Dự báo out-of-sample: xem lại một tuần đã chọn ngoài tập huấn luyện";
  }
  return `Mới nhất: Năm ${year}, Tuần ${String(min).padStart(2, "0")} đến Tuần ${String(latest.week).padStart(2, "0")}`;
}

export default function WeekPicker({
  year,
  week,
  latestYear,
  latestWeek,
  periods,
  onYearChange,
  onWeekChange,
}: Props) {
  const validPeriods = getSortedPeriods(periods, year, week, latestYear, latestWeek);
  const latest = getLatest(validPeriods, latestYear, latestWeek);
  const validYears = validPeriods.map((period) => period.iso_year);
  const safeYear = validYears.includes(year) ? year : latest.year;
  const { min: minWeek, max: maxWeek } = getRange(validPeriods, safeYear, latest);
  const safeWeek = Math.min(Math.max(week, minWeek), maxWeek);
  const pct = maxWeek > minWeek ? ((safeWeek - minWeek) / (maxWeek - minWeek)) * 100 : 0;
  // Tách theo cửa sổ huấn luyện, không theo "có phải năm mới nhất không":
  // năm out-of-sample (2022, 2026...) là dự báo thật, chỉ 2010-2019 mới là backtest.
  const operationalPeriods = validPeriods.filter((period) => !isTrainingYear(period.iso_year));
  const backtestPeriods = validPeriods.filter((period) => isTrainingYear(period.iso_year));
  const yearOptionLabel = (y: number) =>
    y === latest.year ? `${y} (Tuần ${String(latest.week).padStart(2, "0")})` : String(y);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <select
          value={safeYear}
          onChange={(e) => {
            const newYear = Number(e.target.value);
            const { min, max } = getRange(validPeriods, newYear, latest);
            const nextWeek = newYear === latest.year ? max : Math.min(Math.max(week, min), max);
            onYearChange(newYear);
            if (nextWeek !== week) onWeekChange(nextWeek);
          }}
          className="flex-1 h-[30px] bg-[#245b8f] border border-[#60a5fa] rounded-md text-white text-xs font-bold px-2 text-center cursor-pointer focus:outline-none focus:border-white"
        >
          <optgroup label="Dữ liệu vận hành / dự báo">
            {operationalPeriods.map((period) => (
              <option key={period.iso_year} value={period.iso_year}>
                {yearOptionLabel(period.iso_year)}
              </option>
            ))}
          </optgroup>
          {backtestPeriods.length > 0 && (
            <optgroup label="Backtest (năm đã huấn luyện)">
              {backtestPeriods.map((period) => (
                <option key={period.iso_year} value={period.iso_year}>
                  {period.iso_year}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <div className="mb-2 text-[10px] text-slate-100 leading-tight">
        {getHintText(validPeriods, safeYear, latest)}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onWeekChange(Math.max(minWeek, safeWeek - 1))}
          disabled={safeWeek <= minWeek}
          className="w-8 h-8 grid place-items-center bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md text-white hover:border-white hover:bg-[var(--color-panel-raised)] disabled:opacity-35 disabled:cursor-not-allowed"
          aria-label="Tuần trước"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <div className="flex-1 h-8 bg-[#245b8f] border border-[#60a5fa] rounded-md flex items-center justify-center text-xs font-bold text-white">
          Tuần {String(safeWeek).padStart(2, "0")}
        </div>
        <button
          onClick={() => onWeekChange(Math.min(maxWeek, safeWeek + 1))}
          disabled={safeWeek >= maxWeek}
          className="w-8 h-8 grid place-items-center bg-[var(--color-panel-inset)] border border-[var(--color-panel-border)] rounded-md text-white hover:border-white hover:bg-[var(--color-panel-raised)] disabled:opacity-35 disabled:cursor-not-allowed"
          aria-label="Tuần sau"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div className="mt-2 h-1 bg-[var(--color-panel-inset)] rounded-sm overflow-hidden relative">
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-[#3b82f6] transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-100 tabular-nums">
        <span>Tuần {String(minWeek).padStart(2, "0")}</span>
        <span>
          {String(safeWeek).padStart(2, "0")} / {String(maxWeek).padStart(2, "0")}
        </span>
        <span>Tuần {String(maxWeek).padStart(2, "0")}</span>
      </div>
    </div>
  );
}