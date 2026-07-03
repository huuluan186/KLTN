// Cửa sổ huấn luyện cố định (xem CLAUDE.md): train 2010-2019, bỏ 2020-2021,
// validate 2022. Năm trong khoảng này là in-sample — model đã thấy lúc train,
// nên kết quả đẹp giả tạo và phải gắn nhãn "backtest" để trung thực. Năm ngoài
// khoảng (2022, 2026...) là out-of-sample, dự báo thật.
export const TRAINING_YEAR_START = 2010;
export const TRAINING_YEAR_END = 2019;

// True = năm nằm trong tập huấn luyện → prediction là in-sample (backtest thật).
export function isTrainingYear(year: number): boolean {
  return year >= TRAINING_YEAR_START && year <= TRAINING_YEAR_END;
}
