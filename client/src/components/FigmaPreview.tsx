import { Alert, Image, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { FigmaPreviewResult } from "../types";

const { Text } = Typography;

interface FigmaPreviewProps {
  projectId: string;
  kind: "discovery" | "prototype";
}

export function FigmaPreview({ projectId, kind }: FigmaPreviewProps) {
  const [preview, setPreview] = useState<FigmaPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<FigmaPreviewResult>(
          `/api/projects/${projectId}/preview/${kind}`,
          { fallback: "Erro ao carregar o preview." }
        );
        if (!cancelled) setPreview(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Erro ao carregar o preview.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId, kind]);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 48 }}>
        <Spin tip="Gerando preview do Figma..." />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" message={error} showIcon />;
  }

  const images = preview?.images.filter((img) => img.url) ?? [];

  if (images.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message="Nenhuma imagem de preview disponível para este arquivo."
      />
    );
  }

  return (
    <div>
      {preview?.fileName && (
        <Text type="secondary" style={{ display: "block", marginBottom: 16, fontSize: 12 }}>
          {preview.fileName} · {images.length} {images.length === 1 ? "seção" : "seções"}
        </Text>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {images.map((img) => (
          <div
            key={img.id}
            style={{
              border: "1px solid #e6e6e8",
              borderRadius: 8,
              overflow: "hidden",
              background: "#fafafa",
            }}
          >
            <Image
              src={img.url!}
              alt={img.name}
              style={{ width: "100%", display: "block" }}
              placeholder={
                <div style={{ padding: 32, textAlign: "center" }}>
                  <Spin size="small" />
                </div>
              }
            />
            <div style={{ padding: "10px 12px" }}>
              <Text strong style={{ display: "block", fontSize: 13 }}>
                {img.name}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {img.page}
              </Text>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
