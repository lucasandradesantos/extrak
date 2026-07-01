import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Flex,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { downloadText, sanitizeFilename } from "../lib/download";
import { humanizeApiError } from "../lib/humanizeApiError";
import {
  computeFeatureHours,
  formatHm,
  parseHm,
  PT_PLATFORM,
  PT_SALES_MODEL,
  scopeToMarkdown,
  summarizeScope,
} from "../lib/scopeCalc";
import type {
  ScopeConfig,
  ScopeData,
  ScopeFeature,
  ScopeModule,
  ScopePlatform,
  ScopeSalesModel,
} from "../types";

const { Text, Paragraph } = Typography;

function newFeature(): ScopeFeature {
  return {
    id: crypto.randomUUID(),
    title: "Nova feature",
    description: "",
    platforms: ["web"],
    phase: "MVP",
    complexity: "media",
    lowcode_factor: 0.7,
    origin_frames: [],
    confidence: "medium",
    is_active: true,
    hours: { product: 0, development: 0, qa: 0, total: 0 },
  };
}

function newModule(): ScopeModule {
  return {
    id: crypto.randomUUID(),
    name: "Novo módulo",
    category: "Geral",
    description_client: "",
    is_mandatory: false,
    mandatory_reason: "",
    features: [],
  };
}

interface ScopeTabProps {
  projectId: string;
  projectName: string;
  hasDiscovery: boolean;
}

export function ScopeTab({ projectId, projectName, hasDiscovery }: ScopeTabProps) {
  const [scope, setScope] = useState<ScopeData | null>(null);
  const [config, setConfig] = useState<ScopeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  // Janela entre clicar "Gerar" e o backend criar o job. O polling só começa
  // depois (generating), evitando ler o job anterior (error) e reverter a tela.
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Parâmetros comerciais escolhidos no modal antes de gerar (ficam travados no
  // escopo gerado; para mudar, gera de novo).
  const [salesModel, setSalesModel] = useState<ScopeSalesModel>("fechado");
  const [riskMarginPct, setRiskMarginPct] = useState(20);
  const [modalOpen, setModalOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let loadedScope: ScopeData | null = null;
    try {
      const data = await apiFetch<{ scope: ScopeData | null; config: ScopeConfig }>(
        `/api/projects/${projectId}/scope`,
        { fallback: "Erro ao carregar o escopo." }
      );
      loadedScope = data.scope;
      setScope(data.scope);
      setConfig(data.config);
      if (data.scope?.sales_model) setSalesModel(data.scope.sales_model);
      if (typeof data.scope?.risk_margin === "number") {
        setRiskMarginPct(Math.round(data.scope.risk_margin * 100));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar o escopo.");
    } finally {
      setLoading(false);
    }

    // Retoma o acompanhamento se já houver um job rodando no servidor (o usuário
    // reabriu a aba sem clicar em "Gerar escopo").
    try {
      const status = await apiFetch<{
        status: "idle" | "running" | "done" | "error";
        total?: number;
        processed?: number;
        currentStepLabel?: string | null;
        error?: string | null;
      }>(`/api/projects/${projectId}/scope/status`, {
        fallback: "Erro ao verificar a geração do escopo.",
      });
      if (status.status === "running") {
        setProgress({
          current: status.processed ?? 0,
          total: status.total ?? 1,
          label: status.currentStepLabel ?? "Gerando…",
        });
        setGenerating(true);
      } else if (status.status === "error" && !loadedScope) {
        // Última geração falhou e não há escopo salvo — mostra o motivo em vez
        // de uma tela vazia silenciosa (ex.: créditos da IA, falha de gravação).
        setError(
          humanizeApiError(status.error ?? "A última geração de escopo falhou.") +
            ' — clique em "Gerar escopo" para tentar de novo.'
        );
      }
    } catch {
      // Sem job em andamento ou falha pontual — ignora.
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling enquanto a geração roda no backend.
  useEffect(() => {
    if (!generating) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await apiFetch<{
          status: "idle" | "running" | "done" | "error";
          total?: number;
          processed?: number;
          currentStepLabel?: string | null;
          error?: string | null;
          scope?: ScopeData | null;
        }>(`/api/projects/${projectId}/scope/status`, {
          fallback: "Erro ao acompanhar a geração do escopo.",
        });

        if (cancelled) return;
        if (status.status === "idle") return;

        if (status.status === "running") {
          setProgress({
            current: status.processed ?? 0,
            total: status.total ?? 1,
            label: status.currentStepLabel ?? "Gerando…",
          });
          return;
        }

        setGenerating(false);
        setProgress(null);

        if (status.status === "done") {
          setError(null);
          if (status.scope) {
            setScope(status.scope);
            if (status.scope.sales_model) setSalesModel(status.scope.sales_model);
            if (typeof status.scope.risk_margin === "number") {
              setRiskMarginPct(Math.round(status.scope.risk_margin * 100));
            }
          } else {
            await load();
          }
          message.success("Escopo gerado com sucesso.");
          return;
        }

        if (status.status === "error") {
          setError(
            humanizeApiError(status.error ?? "Erro ao gerar o escopo.") +
              ' — clique em "Gerar novamente" para retomar.'
          );
        }
      } catch {
        // Ignora falha pontual de polling.
      }
    };

    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [generating, projectId, load]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function scheduleSave(next: ScopeData) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await apiFetch(`/api/projects/${projectId}/scope`, {
          method: "PATCH",
          body: { scope: next },
          fallback: "Erro ao salvar o escopo.",
        });
      } catch {
        message.error("Não foi possível salvar as edições.");
      } finally {
        setSaving(false);
      }
    }, 1000);
  }

  function applyScope(next: ScopeData) {
    setScope(next);
    scheduleSave(next);
  }

  function mutateModule(moduleId: string, fn: (mod: ScopeModule) => ScopeModule) {
    if (!scope) return;
    applyScope({
      ...scope,
      modules: scope.modules.map((m) => (m.id === moduleId ? fn(m) : m)),
    });
  }

  // Edita campos não-numéricos da feature (nome, fase, ativa) sem mexer nas horas.
  function updateFeature(
    moduleId: string,
    featureId: string,
    patch: Partial<ScopeFeature>
  ) {
    mutateModule(moduleId, (mod) => ({
      ...mod,
      features: mod.features.map((f) => (f.id === featureId ? { ...f, ...patch } : f)),
    }));
  }

  function round1(n: number): number {
    return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
  }

  // Edição direta das horas (Produto/Dev/QA). O Total é a soma; o Valor recalcula
  // a partir do Total. Não depende mais de complexidade/low-code.
  function updateFeatureHours(
    moduleId: string,
    featureId: string,
    key: "product" | "development" | "qa",
    value: number
  ) {
    mutateModule(moduleId, (mod) => ({
      ...mod,
      features: mod.features.map((f) => {
        if (f.id !== featureId) return f;
        const hours = { ...f.hours, [key]: round1(value) };
        hours.total = round1(hours.product + hours.development + hours.qa);
        return { ...f, hours };
      }),
    }));
  }

  function removeFeature(moduleId: string, featureId: string) {
    mutateModule(moduleId, (mod) => ({
      ...mod,
      features: mod.features.filter((f) => f.id !== featureId),
    }));
  }

  function addFeature(moduleId: string) {
    mutateModule(moduleId, (mod) => ({
      ...mod,
      features: [...mod.features, newFeature()],
    }));
  }

  function updateModuleField(moduleId: string, patch: Partial<ScopeModule>) {
    mutateModule(moduleId, (mod) => ({ ...mod, ...patch }));
  }

  function removeModule(moduleId: string) {
    if (!scope) return;
    applyScope({ ...scope, modules: scope.modules.filter((m) => m.id !== moduleId) });
  }

  function addModule() {
    if (!scope) return;
    applyScope({ ...scope, modules: [...scope.modules, newModule()] });
  }

  // Reaplica a régua (fator de IA, complexidade, margem) às horas do escopo
  // atual, sem chamar a IA. Sobrescreve edições manuais de horas.
  function recalcAllHours() {
    if (!scope || !config) return;
    const margin = scope.risk_margin ?? 0;
    applyScope({
      ...scope,
      modules: scope.modules.map((m) => ({
        ...m,
        features: m.features.map((f) => ({
          ...f,
          hours: computeFeatureHours(f, config, margin),
        })),
      })),
    });
  }

  function openGenerateModal() {
    // Pré-preenche o modal com o que já estiver registrado no escopo atual.
    if (scope?.sales_model) setSalesModel(scope.sales_model);
    if (typeof scope?.risk_margin === "number") {
      setRiskMarginPct(Math.round(scope.risk_margin * 100));
    }
    setModalOpen(true);
  }

  async function handleGenerate() {
    setModalOpen(false);
    setError(null);
    setProgress(null);
    setStarting(true);
    try {
      const result = await apiFetch<{
        total: number;
        processed: number;
        currentStepLabel?: string | null;
      }>(`/api/projects/${projectId}/scope/start`, {
        method: "POST",
        body: { sales_model: salesModel, risk_margin: riskMarginPct / 100 },
        fallback: "Erro ao iniciar a geração do escopo.",
      });
      setProgress({
        current: result.processed,
        total: result.total,
        label: result.currentStepLabel ?? "Iniciando…",
      });
      // Só agora ligamos o polling — o job já existe como "running".
      setGenerating(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar o escopo.");
    } finally {
      setStarting(false);
    }
  }

  const summary = scope && config ? summarizeScope(scope, config) : null;

  function featureColumns(moduleId: string) {
    const hourCell = (
      f: ScopeFeature,
      key: "product" | "development" | "qa"
    ) => (
      <InputNumber
        size="small"
        min={0}
        step={0.25}
        value={f.hours[key]}
        disabled={!f.is_active}
        style={{ width: "100%" }}
        formatter={(v) => formatHm(typeof v === "number" ? v : Number(v) || 0)}
        parser={(s) => parseHm(s ?? "")}
        onChange={(v) =>
          updateFeatureHours(moduleId, f.id, key, typeof v === "number" ? v : 0)
        }
      />
    );
    return [
      {
        title: "Módulo / Funcionalidade",
        dataIndex: "title",
        render: (_: unknown, f: ScopeFeature) => (
          <Space direction="vertical" size={2} style={{ width: "100%", minWidth: 0 }}>
            <Input
              size="small"
              value={f.title}
              variant="borderless"
              onChange={(e) => updateFeature(moduleId, f.id, { title: e.target.value })}
            />
            {f.origin_frames.length > 0 && (
              <Tooltip title={f.origin_frames.join(" · ")}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  origem: {f.origin_frames.slice(0, 3).join(", ")}
                  {f.origin_frames.length > 3 ? "…" : ""}
                </Text>
              </Tooltip>
            )}
            {f.confidence === "low" && (
              <Tag color="orange" style={{ fontSize: 10 }}>
                baixa confiança
              </Tag>
            )}
          </Space>
        ),
      },
      {
        title: "Ativa",
        dataIndex: "is_active",
        width: 64,
        align: "center" as const,
        render: (_: unknown, f: ScopeFeature) => (
          <Switch
            size="small"
            checked={f.is_active}
            onChange={(checked) => updateFeature(moduleId, f.id, { is_active: checked })}
          />
        ),
      },
      {
        title: "Fase",
        dataIndex: "phase",
        width: 110,
        render: (_: unknown, f: ScopeFeature) => (
          <Select
            size="small"
            style={{ width: "100%" }}
            value={f.phase}
            options={(config?.phases ?? ["MVP"]).map((p) => ({ value: p, label: p }))}
            onChange={(v) => updateFeature(moduleId, f.id, { phase: v })}
          />
        ),
      },
      {
        title: "Product",
        dataIndex: "product",
        width: 96,
        render: (_: unknown, f: ScopeFeature) => hourCell(f, "product"),
      },
      {
        title: "Dev",
        dataIndex: "development",
        width: 96,
        render: (_: unknown, f: ScopeFeature) => hourCell(f, "development"),
      },
      {
        title: "QA",
        dataIndex: "qa",
        width: 96,
        render: (_: unknown, f: ScopeFeature) => hourCell(f, "qa"),
      },
      {
        title: "Total",
        dataIndex: "total",
        width: 80,
        align: "right" as const,
        render: (_: unknown, f: ScopeFeature) => <Text strong>{formatHm(f.hours.total)}</Text>,
      },
      {
        title: "",
        dataIndex: "actions",
        width: 40,
        render: (_: unknown, f: ScopeFeature) => (
          <Popconfirm
            title="Remover feature?"
            onConfirm={() => removeFeature(moduleId, f.id)}
            okText="Remover"
            cancelText="Cancelar"
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
      },
    ];
  }

  if (loading) {
    return (
      <Card>
        <Empty description="Carregando escopo…" />
      </Card>
    );
  }

  return (
    <Card>
      <Modal
        title={scope ? "Gerar escopo novamente" : "Gerar escopo"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        okText="Gerar escopo"
        cancelText="Cancelar"
        onOk={handleGenerate}
        okButtonProps={{ disabled: !hasDiscovery }}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Text strong>Modelo de venda</Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              value={salesModel}
              options={[
                { value: "fechado", label: "Escopo fechado" },
                { value: "banco_horas", label: "Banco de horas" },
              ]}
              onChange={(v) => setSalesModel(v as ScopeSalesModel)}
            />
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
              {salesModel === "fechado"
                ? "A Extrak assume o risco de estouro de prazo — a IA estima de forma conservadora."
                : "O cliente compra horas conforme o desenvolvimento avança."}
            </Text>
          </div>
          <div>
            <Text strong>Margem de erro</Text>
            <div style={{ marginTop: 4 }}>
              <InputNumber
                min={0}
                max={100}
                step={5}
                value={riskMarginPct}
                addonAfter="%"
                style={{ width: 140 }}
                onChange={(v) => setRiskMarginPct(typeof v === "number" ? v : 0)}
              />
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
              Aplicada às horas (Produto/Dev/QA) de cada feature e travada neste escopo.
            </Text>
          </div>
          {scope && (
            <Alert
              type="warning"
              showIcon
              message="Gerar de novo substitui o escopo atual e recalcula tudo com estes valores."
            />
          )}
        </Space>
      </Modal>

      <Flex wrap="wrap" gap={8} align="center" style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          onClick={openGenerateModal}
          disabled={generating || starting || !hasDiscovery}
          loading={generating || starting}
        >
          {scope ? "Gerar novamente" : "Gerar escopo"}
        </Button>
        {scope && config && (
          <>
            <Popconfirm
              title="Recalcular horas pela régua atual?"
              description="Reaplica o fator de IA, complexidade e margem a todas as features. Sobrescreve edições manuais de horas."
              onConfirm={() => recalcAllHours()}
              okText="Recalcular"
              cancelText="Cancelar"
            >
              <Button>Recalcular horas</Button>
            </Popconfirm>
            <Button onClick={() => addModule()}>+ Módulo</Button>
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(
                  scopeToMarkdown(scope, config, projectName)
                );
                message.success("Escopo copiado (Markdown).");
              }}
            >
              Copiar MD
            </Button>
            <Button
              onClick={() =>
                downloadText(
                  scopeToMarkdown(scope, config, projectName),
                  `Escopo_${sanitizeFilename(projectName)}.md`
                )
              }
            >
              Baixar .md
            </Button>
            <Button
              onClick={() =>
                downloadText(
                  JSON.stringify(scope, null, 2),
                  `Escopo_${sanitizeFilename(projectName)}.json`
                )
              }
            >
              Baixar .json
            </Button>
            {saving && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                salvando…
              </Text>
            )}
          </>
        )}
      </Flex>

      {error && (
        <Alert type="error" message={humanizeApiError(error)} showIcon style={{ marginBottom: 16 }} />
      )}

      {!hasDiscovery && (
        <Empty description="Importe o Discovery deste projeto antes de gerar o escopo." />
      )}

      {(generating || starting) && progress && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Gerando escopo — ${progress.current + 1}/${progress.total}: ${progress.label}`}
          description={
            <>
              <Progress
                percent={Math.round(((progress.current + 1) / progress.total) * 100)}
                status="active"
                strokeColor="#000"
                style={{ marginTop: 8 }}
              />
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                A geração roda no servidor — você pode fechar esta aba. A IA lê o Discovery em
                passos e calcula as horas no fim.
              </Text>
            </>
          }
        />
      )}

      {hasDiscovery && !scope && !generating && !starting && (
        <Empty description='Clique em "Gerar escopo" para a IA mapear módulos e horas a partir do Discovery.' />
      )}

      {scope && config && summary && (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Flex wrap="wrap" gap={28} align="center">
              <Statistic title="Total de horas" value={formatHm(summary.totalHours)} />
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                  Modelo / margem
                </Text>
                <Tag color={(scope.sales_model ?? "fechado") === "fechado" ? "red" : "blue"}>
                  {PT_SALES_MODEL[scope.sales_model ?? "fechado"]}
                </Tag>
                <Tag>margem {Math.round((scope.risk_margin ?? 0) * 100)}%</Tag>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                  Por disciplina
                </Text>
                <Tag>Produto {formatHm(summary.byDiscipline.product)}</Tag>
                <Tag>Dev {formatHm(summary.byDiscipline.development)}</Tag>
                <Tag>QA {formatHm(summary.byDiscipline.qa)}</Tag>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                  Por fase
                </Text>
                {Object.entries(summary.byPhase).map(([phase, hours]) => (
                  <Tag key={phase}>
                    {phase} {formatHm(hours)}
                  </Tag>
                ))}
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                  Por plataforma
                </Text>
                {(Object.keys(PT_PLATFORM) as ScopePlatform[])
                  .filter((p) => summary.byPlatform[p] > 0)
                  .map((p) => (
                    <Tag key={p}>
                      {PT_PLATFORM[p]} {formatHm(summary.byPlatform[p])}
                    </Tag>
                  ))}
              </div>
            </Flex>
            {(summary.mandatoryModules > 0 || summary.lowConfidenceFeatures > 0) && (
              <Flex gap={12} wrap="wrap" align="center" style={{ marginTop: 12 }}>
                {summary.mandatoryModules > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {summary.mandatoryModules} módulo(s) obrigatório(s)
                  </Text>
                )}
                {summary.lowConfidenceFeatures > 0 && (
                  <Tag color="orange">
                    {summary.lowConfidenceFeatures} feature(s) com baixa confiança — revise
                  </Tag>
                )}
              </Flex>
            )}
          </Card>

          <div style={{ width: "100%" }}>
            <Collapse
              defaultActiveKey={scope.modules.map((m) => m.id)}
              items={scope.modules.map((mod) => {
                const moduleHours = mod.features.reduce(
                  (sum, f) => sum + (f.is_active ? f.hours.total : 0),
                  0
                );
                return {
                  key: mod.id,
                  label: (
                    <Flex justify="space-between" align="center" gap={8} wrap="wrap">
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        <Input
                          size="small"
                          value={mod.name}
                          variant="borderless"
                          style={{ fontWeight: 600, flex: 1, minWidth: 0 }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => updateModuleField(mod.id, { name: e.target.value })}
                        />
                        {mod.is_mandatory && (
                          <Tag color="red" style={{ flexShrink: 0 }}>
                            obrigatório
                          </Tag>
                        )}
                      </div>
                      <Space style={{ flexShrink: 0 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {formatHm(moduleHours)}
                        </Text>
                        <Tooltip title="Marcar módulo como obrigatório">
                          <Switch
                            size="small"
                            checkedChildren="obr."
                            unCheckedChildren="opc."
                            checked={mod.is_mandatory}
                            onClick={(_checked, e) => e.stopPropagation()}
                            onChange={(checked) =>
                              updateModuleField(mod.id, { is_mandatory: checked })
                            }
                          />
                        </Tooltip>
                        <Popconfirm
                          title="Remover módulo inteiro?"
                          onConfirm={() => removeModule(mod.id)}
                          okText="Remover"
                          cancelText="Cancelar"
                        >
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Popconfirm>
                      </Space>
                    </Flex>
                  ),
                  children: (
                    <>
                      <Table<ScopeFeature>
                        rowKey="id"
                        size="small"
                        pagination={false}
                        scroll={{ x: 720 }}
                        dataSource={mod.features}
                        columns={featureColumns(mod.id)}
                        locale={{ emptyText: "Sem features neste módulo." }}
                      />
                      <Button
                        size="small"
                        type="dashed"
                        icon={<PlusOutlined />}
                        style={{ marginTop: 8 }}
                        onClick={() => addFeature(mod.id)}
                      >
                        Feature
                      </Button>
                    </>
                  ),
                };
              })}
            />
          </div>
        </>
      )}

      {scope && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          As horas recalculam em tempo real ao editar; as mudanças salvam automaticamente.
        </Paragraph>
      )}
    </Card>
  );
}
