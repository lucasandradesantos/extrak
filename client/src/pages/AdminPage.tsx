import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { ROLE_LABELS } from "../lib/labels";
import type { AdminUser, Team, UserRole } from "../types";

const { Paragraph, Title } = Typography;

interface AnthropicKeyStatus {
  configured: boolean;
  source: "db" | "env" | null;
  masked: string | null;
}

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

  const [teamForm] = Form.useForm();
  const [userForm] = Form.useForm();
  const [keyForm] = Form.useForm();

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

  useEffect(() => {
    loadAll();
    if (isSuper) loadKeyStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper]);

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
