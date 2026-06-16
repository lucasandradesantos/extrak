import { ExportOutlined } from "@ant-design/icons";
import { Button, Flex, Segmented } from "antd";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ProjectSource } from "../types";
import { FigmaPreview } from "./FigmaPreview";

type ViewMode = "text" | "preview";

interface SourceViewPanelProps {
  projectId: string;
  kind: "discovery" | "prototype";
  source: ProjectSource | undefined;
  figmaUrl: string | null | undefined;
  emptyText: string;
  copyLabel: string;
  onCopy: (text: string, label: string) => void;
  summaryChips: ReactNode;
}

export function SourceViewPanel({
  projectId,
  kind,
  source,
  figmaUrl,
  emptyText,
  copyLabel,
  onCopy,
  summaryChips,
}: SourceViewPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const text = source?.discovery_text ?? "";

  return (
    <>
      <Flex justify="space-between" align="center" wrap="wrap" gap={12} style={{ marginBottom: 16 }}>
        <Flex align="center" wrap="wrap" gap={12}>
          {summaryChips}
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
            options={[
              { label: "Texto extraído", value: "text" },
              { label: "Preview Figma", value: "preview" },
            ]}
          />
        </Flex>
        <Flex gap={8} wrap="wrap">
          {figmaUrl && (
            <Button
              icon={<ExportOutlined />}
              href={figmaUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Abrir no Figma
            </Button>
          )}
          {viewMode === "text" && (
            <Button onClick={() => onCopy(text, copyLabel)} disabled={!text}>
              Copiar
            </Button>
          )}
        </Flex>
      </Flex>

      {viewMode === "text" ? (
        <pre className="json-pre">{text || emptyText}</pre>
      ) : (
        <FigmaPreview projectId={projectId} kind={kind} />
      )}
    </>
  );
}
