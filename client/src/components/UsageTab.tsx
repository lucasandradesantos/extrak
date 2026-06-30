import { Card, Empty, Flex, Statistic, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

const { Text, Paragraph } = Typography;

const FEATURE_LABELS: Record<string, string> = {
  analysis: "Análise (IA)",
  prd: "PRD",
  scope: "Escopo",
  spec: "Specs",
  qa: "QA",
  outros: "Outros",
};

interface FeatureUsage {
  feature: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

interface UsageResponse {
  totals: { input_tokens: number; output_tokens: number; cost_usd: number; calls: number };
  byFeature: FeatureUsage[];
}

function fmt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function usd(n: number): string {
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function UsageTab({ projectId }: { projectId: string }) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch<UsageResponse>(`/api/projects/${projectId}/usage`, {
          fallback: "Erro ao carregar o consumo.",
        });
        if (active) setData(res);
      } catch {
        if (active) setData(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const hasData = data && data.totals.calls > 0;

  return (
    <Card loading={loading}>
      <Paragraph type="secondary" style={{ marginTop: 0 }}>
        Consumo de tokens da IA neste projeto, por etapa. O custo é uma{" "}
        <strong>estimativa</strong> (tokens × preço do modelo) — confira o valor real no
        faturamento da Anthropic.
      </Paragraph>

      {!hasData ? (
        <Empty description="Nenhum consumo de IA registrado ainda neste projeto." />
      ) : (
        <>
          <Flex gap={32} wrap="wrap" style={{ marginBottom: 24 }}>
            <Statistic title="Custo estimado" value={usd(data!.totals.cost_usd)} />
            <Statistic title="Tokens de entrada" value={fmt(data!.totals.input_tokens)} />
            <Statistic title="Tokens de saída" value={fmt(data!.totals.output_tokens)} />
            <Statistic title="Chamadas à IA" value={data!.totals.calls} />
          </Flex>

          <Table<FeatureUsage>
            rowKey="feature"
            size="small"
            pagination={false}
            dataSource={data!.byFeature}
            columns={[
              {
                title: "Etapa",
                dataIndex: "feature",
                render: (f: string) => <Tag>{FEATURE_LABELS[f] ?? f}</Tag>,
              },
              {
                title: "Chamadas",
                dataIndex: "calls",
                align: "right",
              },
              {
                title: "Tokens entrada",
                dataIndex: "input_tokens",
                align: "right",
                render: (v: number) => fmt(v),
              },
              {
                title: "Tokens saída",
                dataIndex: "output_tokens",
                align: "right",
                render: (v: number) => fmt(v),
              },
              {
                title: "Custo estimado",
                dataIndex: "cost_usd",
                align: "right",
                render: (v: number) => <Text strong>{usd(v)}</Text>,
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
