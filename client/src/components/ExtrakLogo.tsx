import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

type Variant = "horizontal" | "stacked" | "avatar";

interface ExtrakLogoProps {
  variant?: Variant;
  theme?: "light" | "dark";
  height?: number;
  to?: string;
}

const INK = { light: "#000000", dark: "#ffffff" } as const;
const MUTED = {
  light: "rgba(0, 0, 0, 0.55)",
  dark: "rgba(255, 255, 255, 0.55)",
} as const;

const tagStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontWeight: 500,
  textTransform: "uppercase",
  lineHeight: 1,
};

const wordStyle: CSSProperties = {
  fontFamily: "'Unbounded', sans-serif",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: 1,
};

function HorizontalLogo({ theme, height }: { theme: "light" | "dark"; height: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: height * 0.45 }}>
      <span
        className="extrak-display"
        style={{
          ...wordStyle,
          fontSize: height,
          color: INK[theme],
        }}
      >
        extrak
      </span>
      <span
        style={{
          ...tagStyle,
          fontSize: Math.max(9, height * 0.38),
          letterSpacing: "0.3em",
          color: MUTED[theme],
          paddingBottom: height * 0.1,
        }}
      >
        from figma
      </span>
    </div>
  );
}

function StackedLogo({ theme, height }: { theme: "light" | "dark"; height: number }) {
  const wordSize = height * 0.62;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <span
        className="extrak-display"
        style={{
          ...wordStyle,
          fontSize: wordSize,
          color: INK[theme],
        }}
      >
        extrak
      </span>
      <span
        style={{
          ...tagStyle,
          fontSize: Math.max(9, height * 0.18),
          letterSpacing: "0.42em",
          color: MUTED[theme],
          marginTop: height * 0.12,
        }}
      >
        from figma
      </span>
    </div>
  );
}

function AvatarLogo({ theme, height }: { theme: "light" | "dark"; height: number }) {
  const onLightBg = theme === "light";
  return (
    <div
      style={{
        width: height,
        height: height,
        borderRadius: height * 0.24,
        background: onLightBg ? INK.light : INK.dark,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      aria-hidden
    >
      <span
        className="extrak-display"
        style={{
          ...wordStyle,
          fontSize: height * 0.55,
          color: onLightBg ? INK.dark : INK.light,
          transform: "translateY(6%)",
        }}
      >
        e
      </span>
    </div>
  );
}

export function ExtrakLogo({
  variant = "horizontal",
  theme = "light",
  height = 28,
  to,
}: ExtrakLogoProps) {
  let content: ReactNode;
  if (variant === "stacked") {
    content = <StackedLogo theme={theme} height={height} />;
  } else if (variant === "avatar") {
    content = <AvatarLogo theme={theme} height={height} />;
  } else {
    content = <HorizontalLogo theme={theme} height={height} />;
  }

  const wrapped = (
    <span
      role="img"
      aria-label="Extrak — from Figma"
      style={{ display: "inline-flex", lineHeight: 0 }}
    >
      {content}
    </span>
  );

  if (to) {
    return (
      <Link to={to} style={{ display: "inline-flex", lineHeight: 0, textDecoration: "none" }}>
        {wrapped}
      </Link>
    );
  }

  return wrapped;
}
