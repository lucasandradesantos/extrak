import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Flex,
  Input,
  InputNumber,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { ROLE_LABELS } from "../lib/labels";
import type { AdminUser, ScopeConfig, Team, UserRole } from "../types";

const { Paragraph, Title } = Typography;

interface AnthropicKeyStatus {
  configured: boolean;
  source: "db" | "env" | null;
  masked: string | null;
}

interface ProjectUsage {
  project_id: string;
  name: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

interface UsageResponse {
  totals: { input_tokens: number; output_tokens: number; cost_usd: number; calls: number };
  byProject: ProjectUsage[];
}

const fmtNum = (n: number) => n.toLocaleString("pt-BR");
const fmtUsd = (n: number) =>
  `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AdminPage() {
  const { profile } = useAuth();
  const isSuper = profile?.role === "super_admin";

  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [creatingTeam, setCreatingTeam] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);

  const [keyStatus, setKeyStatus] = useState<AnthropicKeyStatus | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  const [savingScopeConfig, setSavingScopeConfig] = useState(false);

  const [usage, setUsage] = useState<UsageResponse | null>(null);

  const [teamForm] = Form.useForm();
  const [userForm] = Form.useForm();
  const [keyForm] = Form.useForm();
  const [scopeForm] = Form.useForm();

  async function loadAll() {
    try {
      const [t, u] = await Promise.all([
        apiFetch<{ teams: Team[] }>("/api/admin/teams", {
          fallback: "Erro ao listar times.",
        }),
        apiFetch<{ users: AdminUser[] }>("/api/admin/users", {
          fallback: "Erro ao listar usuários.",
        }),
      ]);
      setTeams(t.teams);
      setUsers(u.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar.");
    }
  }

  async function loadKeyStatus() {
    try {
      const status = await apiFetch<AnthropicKeyStatus>(
        "/api/admin/settings/anthropic",
        { fallback: "Erro ao carregar a chave da API." }
      );
      setKeyStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar a chave.");
    }
  }

  async function loadScopeConfig() {
    try {
      const { config } = await apiFetch<{ config: ScopeConfig }>(
        "/api/admin/settings/scope",
        { fallback: "Erro ao carregar a configuração de escopo." }
      );
      scopeForm.setFieldsValue({
        hourly_rate: config.hourly_rate,
        platform_multipliers: config.platform_multipliers,
        buffers: config.buffers,
        complexity_ranges: config.complexity_ranges,
        product_ranges: config.product_ranges,
        ai_factor: config.ai_factor,
        phases: config.phases.join(", "),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar a configuração.");
    }
  }

  async function loadUsage() {
    try {
      const res = await apiFetch<UsageResponse>("/api/admin/usage", {
        fallback: "Erro ao carregar o consumo.",
      });
      setUsage(res);
    } catch {
      setUsage(null);
    }
  }

  useEffect(() => {
    loadAll();
    loadUsage();
    if (isSuper) {
      loadKeyStatus();
      loadScopeConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper]);

  async function handleSaveScopeConfig(values: {
    hourly_rate: number;
    platform_multipliers: ScopeConfig["platform_multipliers"];
    buffers: ScopeConfig["buffers"];
    complexity_ranges: ScopeConfig["complexity_ranges"];
    product_ranges: ScopeConfig["product_ranges"];
    ai_factor: number;
    phases: string;
  }) {
    setSavingScopeConfig(true);
    setError(null);
    try {
      const config: ScopeConfig = {
        hourly_rate: values.hourly_rate,
        platform_multipliers: values.platform_multipliers,
        buffers: values.buffers,
        complexity_ranges: values.complexity_ranges,
        product_ranges: values.product_ranges,
        ai_factor: values.ai_factor,
        phases: values.phases
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      };
      const { config: saved } = await apiFetch<{ config: ScopeConfig }>(
        "/api/admin/settings/scope",
        { method: "PUT", body: { config }, fallback: "Erro ao salvar a configuração." }
      );
      scopeForm.setFieldsValue({ phases: saved.phases.join(", ") });
      flash("Configuração de escopo salva.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar a configuração.");
    } finally {
      setSavingScopeConfig(false);
    }
  }

  function flash(message: string) {
    setFeedback(message);
    setTimeout(() => setFeedback(null), 2500);
  }

  async function handleCreateTeam(values: { name: string }) {
    setCreatingTeam(true);
    setError(null);
    try {
      await apiFetch("/api/admin/teams", {
        method: "POST",
        body: { name: values.name.trim() },
        fallback: "Erro ao criar time.",
      });
      teamForm.resetFields();
      flash("Time criado.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar time.");
    } finally {
      setCreatingTeam(false);
    }
  }

  async function handleSaveKey(values: { apiKey: string }) {
    setSavingKey(true);
    setError(null);
    try {
      const status = await apiFetch<AnthropicKeyStatus>(
        "/api/admin/settings/anthropic",
        {
          method: "PUT",
          body: { apiKey: values.apiKey.trim() },
          fallback: "Erro ao salvar a chave.",
        }
      );
      setKeyStatus(status);
      keyForm.resetFields();
      flash("Chave da API salva.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar a chave.");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleRemoveKey() {
    if (
      !confirm("Remover a chave salva?")
    ) {
      return;
    }
    setError(null);
    try {
      const status = await apiFetch<AnthropicKeyStatus>(
        "/api/admin/settings/anthropic",
        { method: "DELETE", fallback: "Erro ao remover a chave." }
      );
      setKeyStatus(status);
      flash("Chave removida.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao remover a chave.");
    }
  }

  async function handleCreateUser(values: {
    email: string;
    password: string;
    full_name?: string;
    role: UserRole;
    team_id?: string;
  }) {
    setCreatingUser(true);
    setError(null);
    try {
      await apiFetch("/api/admin/users", {
        method: "POST",
        body: {
          email: values.email.trim(),
          password: values.password,
          full_name: values.full_name?.trim() || undefined,
          role: values.role,
          team_id: isSuper ? values.team_id || undefined : undefined,
        },
        fallback: "Erro ao criar usuário.",
      });
      userForm.resetFields();
      userForm.setFieldsValue({ role: "member" });
      flash("Usuário criado.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar usuário.");
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleDeleteUser(userId: string) {
    if (!confirm("Remover este usuário? Esta ação não pode ser desfeita.")) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
        fallback: "Erro ao remover usuário.",
      });
      flash("Usuário removido.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao remover.");
    }
  }

  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {error && <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} />}
      {feedback && <Alert type="success" message={feedback} showIcon />}

      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          Consumo de IA
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Tokens consumidos por projeto. O custo é uma <strong>estimativa</strong> (tokens ×
          preço do modelo) — confira o valor real no faturamento da Anthropic.
        </Paragraph>

        {usage && usage.totals.calls > 0 ? (
          <>
            <Flex gap={32} wrap="wrap" style={{ marginBottom: 20 }}>
              <Statistic title="Custo estimado total" value={fmtUsd(usage.totals.cost_usd)} />
              <Statistic title="Tokens de entrada" value={fmtNum(usage.totals.input_tokens)} />
              <Statistic title="Tokens de saída" value={fmtNum(usage.totals.output_tokens)} />
              <Statistic title="Chamadas à IA" value={usage.totals.calls} />
            </Flex>

            <Table<ProjectUsage>
              rowKey="project_id"
              size="small"
              pagination={false}
              dataSource={usage.byProject}
              columns={[
                { title: "Projeto", dataIndex: "name" },
                { title: "Chamadas", dataIndex: "calls", align: "right" },
                {
                  title: "Tokens entrada",
                  dataIndex: "input_tokens",
                  align: "right",
                  render: (v: number) => fmtNum(v),
                },
                {
                  title: "Tokens saída",
                  dataIndex: "output_tokens",
                  align: "right",
                  render: (v: number) => fmtNum(v),
                },
                {
                  title: "Custo estimado",
                  dataIndex: "cost_usd",
                  align: "right",
                  render: (v: number) => <strong>{fmtUsd(v)}</strong>,
                },
              ]}
            />
          </>
        ) : (
          <Empty description="Nenhum consumo de IA registrado ainda." />
        )}
      </Card>

      {isSuper && (
        <Card>
          <Title level={4} style={{ marginTop: 0 }}>
            Times
          </Title>
          <Form form={teamForm} layout="inline" onFinish={handleCreateTeam} style={{ marginBottom: 16 }}>
            <Form.Item
              name="name"
              rules={[{ required: true, message: "Informe o nome do time." }]}
            >
              <Input placeholder="Nome do novo time" style={{ minWidth: 240 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={creatingTeam}>
                Criar time
              </Button>
            </Form.Item>
          </Form>
          {teams.length === 0 ? (
            <Empty description="Nenhum time cadastrado." />
          ) : (
            <Space wrap>
              {teams.map((t) => (
                <Tag key={t.id}>{t.name}</Tag>
              ))}
            </Space>
          )}
        </Card>
      )}

      {isSuper && (
        <Card>
          <Title level={4} style={{ marginTop: 0 }}>
            Chave da API do Claude
          </Title>
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            Configure aqui a chave da Anthropic usada por toda a plataforma. Ela fica
            guardada com segurança no servidor e nunca é exibida por completo.
          </Paragraph>

          <div style={{ marginBottom: 16 }}>
            {keyStatus?.configured ? (
              <Tag>
                {keyStatus.source === "db" ? "Configurada no painel" : "Chave ativa"}
                : <strong>{keyStatus.masked}</strong>
              </Tag>
            ) : (
              <Tag color="error">Nenhuma chave configurada</Tag>
            )}
          </div>

          <Form form={keyForm} layout="inline" onFinish={handleSaveKey}>
            <Form.Item
              name="apiKey"
              rules={[{ required: true, message: "Informe a chave." }]}
            >
              <Input.Password
                placeholder="sk-ant-..."
                autoComplete="off"
                style={{ minWidth: 280 }}
              />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={savingKey}>
                Salvar chave
              </Button>
            </Form.Item>
            {keyStatus?.source === "db" && (
              <Form.Item>
                <Button onClick={handleRemoveKey} disabled={savingKey}>
                  Remover
                </Button>
              </Form.Item>
            )}
          </Form>
        </Card>
      )}

      {isSuper && (
        <Card>
          <Title level={4} style={{ marginTop: 0 }}>
            Cálculo de escopo
          </Title>
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            Parâmetros globais usados pela calculadora de escopo: valor da hora,
            multiplicadores por plataforma, buffers de QA/Produto, horas-base por
            complexidade e fases. Aplica-se a todos os projetos.
          </Paragraph>

          <Form
            form={scopeForm}
            layout="vertical"
            onFinish={handleSaveScopeConfig}
            requiredMark={false}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 16,
              }}
            >
              <Form.Item label="Valor da hora (R$)" name="hourly_rate">
                <InputNumber min={0} step={10} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Multiplicador — Web" name={["platform_multipliers", "web"]}>
                <InputNumber min={0} step={0.1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                label="Multiplicador — Mobile nativo"
                name={["platform_multipliers", "mobile_native"]}
              >
                <InputNumber min={0} step={0.1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                label="Multiplicador — Mobile responsivo"
                name={["platform_multipliers", "mobile_responsive"]}
              >
                <InputNumber min={0} step={0.1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Buffer QA (fração do Dev)" name={["buffers", "qa"]}>
                <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Dev — Simples (h)" name={["complexity_ranges", "simples"]}>
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Dev — Média (h)" name={["complexity_ranges", "media"]}>
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Dev — Difícil (h)" name={["complexity_ranges", "dificil"]}>
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                label="Produto — Simples (h)"
                name={["product_ranges", "simples"]}
                tooltip="Horas de Produto (discovery + design/protótipo) por feature simples. Disciplina própria, somada por feature."
              >
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Produto — Média (h)" name={["product_ranges", "media"]}>
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="Produto — Difícil (h)" name={["product_ranges", "dificil"]}>
                <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                label="Fator de IA (0,05–1)"
                name="ai_factor"
                tooltip="Produtividade do time com IA. 1 = ritmo tradicional; 0.4 = ~60% mais rápido. Quanto menor, menos horas de desenvolvimento."
              >
                <InputNumber min={0.05} max={1} step={0.05} style={{ width: "100%" }} />
              </Form.Item>
            </div>
            <Form.Item
              label="Fases (separadas por vírgula)"
              name="phases"
              rules={[{ required: true, message: "Informe ao menos uma fase." }]}
            >
              <Input placeholder="MVP, V2, V3" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={savingScopeConfig}>
              Salvar configuração
            </Button>
          </Form>
        </Card>
      )}

      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          Criar usuário
        </Title>
        <Form
          form={userForm}
          layout="vertical"
          onFinish={handleCreateUser}
          initialValues={{ role: "member" }}
          requiredMark={false}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            <Form.Item
              label="Email"
              name="email"
              rules={[
                { required: true, message: "Informe o email." },
                { type: "email", message: "Email inválido." },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              label="Senha (mín. 8)"
              name="password"
              rules={[
                { required: true, message: "Informe a senha." },
                { min: 8, message: "Mínimo de 8 caracteres." },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item label="Nome" name="full_name">
              <Input />
            </Form.Item>
            <Form.Item label="Papel" name="role">
              <Select
                options={[
                  { value: "member", label: "Membro" },
                  { value: "team_admin", label: "Admin do time" },
                  ...(isSuper
                    ? [{ value: "super_admin", label: "Super-admin" }]
                    : []),
                ]}
              />
            </Form.Item>
            {isSuper && (
              <Form.Item label="Time" name="team_id">
                <Select
                  allowClear
                  placeholder="— selecione —"
                  options={teams.map((t) => ({ value: t.id, label: t.name }))}
                />
              </Form.Item>
            )}
          </div>
          <Button type="primary" htmlType="submit" loading={creatingUser}>
            Criar usuário
          </Button>
        </Form>
      </Card>

      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          Usuários
        </Title>
        <Table
          rowKey="id"
          dataSource={users}
          pagination={false}
          locale={{ emptyText: "Nenhum usuário ainda." }}
          columns={[
            { title: "Email", dataIndex: "email", render: (v) => v ?? "—" },
            { title: "Nome", dataIndex: "full_name", render: (v) => v ?? "—" },
            {
              title: "Papel",
              dataIndex: "role",
              render: (role: UserRole) => ROLE_LABELS[role],
            },
            {
              title: "Time",
              dataIndex: "team_id",
              render: (teamId: string | null) =>
                teamId ? teamNameById.get(teamId) ?? "—" : "—",
            },
            {
              title: "",
              key: "actions",
              render: (_, u) =>
                u.id !== profile?.id ? (
                  <Button type="link" danger onClick={() => handleDeleteUser(u.id)}>
                    Remover
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
