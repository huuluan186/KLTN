import { Link } from "react-router-dom";

interface Props {
  size?: number;
  textSize?: string;
  withText?: boolean;
}

export default function Logo({ size = 30, textSize = "text-[15px]", withText = true }: Props) {
  return (
    <Link
      to="/"
      aria-label="Về bản đồ rủi ro EpiWeather"
      className="flex items-center gap-2.5 font-bold tracking-tight select-none rounded-md cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 hover:opacity-85 transition-opacity"
    >
      <img
        src="/Logo_v2-removebg.png"
        alt="EpiWeather"
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain" }}
        className="shrink-0"
      />
      {withText && (
        <span className={`${textSize} text-white`}>
          EpiWeather
        </span>
      )}
    </Link>
  );
}
