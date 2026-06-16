import type { ThemeConfig } from "antd";

export const EXTRAK_COLORS = {
  ink: "#000000",
  paper: "#ffffff",
  muted: "rgba(0, 0, 0, 0.55)",
  border: "#e6e6e8",
  surface: "#fafafa",
} as const;

export const extrakTheme: ThemeConfig = {
  token: {
    colorPrimary: EXTRAK_COLORS.ink,
    colorText: EXTRAK_COLORS.ink,
    colorTextSecondary: EXTRAK_COLORS.muted,
    colorBgBase: EXTRAK_COLORS.paper,
    colorBgLayout: EXTRAK_COLORS.surface,
    colorBorder: EXTRAK_COLORS.border,
    colorBorderSecondary: EXTRAK_COLORS.border,
    borderRadius: 8,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontFamilyCode: "'JetBrains Mono', ui-monospace, monospace",
    controlHeight: 40,
  },
  components: {
    Layout: {
      headerBg: EXTRAK_COLORS.paper,
      bodyBg: EXTRAK_COLORS.surface,
      siderBg: EXTRAK_COLORS.paper,
    },
    Menu: {
      itemSelectedBg: "#f0f0f2",
      itemSelectedColor: EXTRAK_COLORS.ink,
      itemHoverBg: "#f5f5f7",
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      fontWeight: 500,
    },
    Card: {
      paddingLG: 24,
    },
    Tabs: {
      inkBarColor: EXTRAK_COLORS.ink,
      itemSelectedColor: EXTRAK_COLORS.ink,
      itemHoverColor: EXTRAK_COLORS.ink,
    },
  },
};
