import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  List,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAnalysis } from "../analysis/AnalysisContext";
import { ProjectFormModal, type ProjectFormValues } from "../components/ProjectFormModal";
import { apiFetch } from "../lib/api";
import { formatActor } from "../lib/actors";
import type { ProjectSummary } from "../types";

const { Text, Title } = Typography;

type ProjectFilter = "all" | "analyzing" | "with-prototype" | "discovery-only";

const FILTER_OPTIONS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "analyzing", label: "Analisando" },
  { value: "with-prototype", label: "Com protótipo" },
  { value: "discovery-only", label: "Somente Discovery" },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const { jobs, completion } = useAnalysis();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");

  async function loadProjects() {
    setLoadingList(true);
    try {
      const data = await apiFetch<{ projects: ProjectSummary[] }>("/api/projects", {
        fallback: "Erro ao listar projetos.",
      });
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao listar projetos.");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (completion) loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completion]);

  function isProjectAnalyzing(project: ProjectSummary): boolean {
    const live = jobs[project.id];
    if (live?.status === "running") return true;
    return project.analysis_status === "running";
  }

  function projectProgress(project: ProjectSummary): string | null {
    const live = jobs[project.id];
    const progress = live ?? project.analysis_progress;
    if (!isProjectAnalyzing(project) || !progress) return null;
    return `${progress.processed}/${progress.total} blocos`;
  }

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (query && !p.name.toLowerCase().includes(query)) return false;
      if (filter === "analyzing" && !isProjectAnalyzing(p)) return false;
      if (filter === "with-prototype" && !p.prototype_url) return false;
      if (filter === "discovery-only" && p.prototype_url) return false;
      return true;
    });
  }, [projects, search, filter, jobs]);

  function closeModal() {
    setModalOpen(false);
    setError(null);
  }

  async function handleCreate(values: ProjectFormValues) {
    setCreating(true);
    setError(null);
    try {
      const data = await apiFetch<{ project: ProjectSummary }>("/api/projects", {
        method: "POST",
        body: {
          name: values.name?.trim() || undefined,
          discoveryUrl: values.discoveryUrl.trim(),
          prototypeUrl: values.prototypeUrl?.trim() || undefined,
        },
        fallback: "Erro ao criar projeto.",
      });
      closeModal();
      navigate(`/projects/${data.project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar projeto.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Card>
        <Flex justify="space-between" align="center" wrap="wrap" gap={12} style={{ marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>
            Projetos
          </Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            Novo projeto
          </Button>
        </Flex>

        {error && !modalOpen && (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
        )}

        {projects.length > 0 && (
          <Flex wrap="wrap" gap={12} style={{ marginBottom: 16 }}>
            <Input
              allowClear
              placeholder="Buscar por nome..."
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: "1 1 220px", maxWidth: 360 }}
            />
            <Select
              value={filter}
              onChange={setFilter}
              options={FILTER_OPTIONS}
              style={{ minWidth: 180 }}
            />
          </Flex>
        )}

        {loadingList ? (
          <div style={{ textAlign: "center", padding: 32 }}>
            <Spin />
          </div>
        ) : projects.length === 0 ? (
          <Empty description="Nenhum projeto ainda.">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              Criar primeiro projeto
            </Button>
          </Empty>
        ) : filteredProjects.length === 0 ? (
          <Empty description="Nenhum projeto corresponde ao filtro." />
        ) : (
          <List
            itemLayout="horizontal"
            dataSource={filteredProjects}
            renderItem={(p) => (
              <List.Item
                style={{ cursor: "pointer" }}
                onClick={() => navigate(`/projects/${p.id}`)}
                actions={[
                  <Text key="date" type="secondary" style={{ fontSize: 12 }}>
                    {new Date(p.updated_at).toLocaleDateString("pt-BR")}
                  </Text>,
                ]}
              >
                <List.Item.Meta
                  title={p.name}
                  description={
                    <Space direction="vertical" size={2}>
                      {p.created_by && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          Criado por {formatActor(p.created_by)}
                        </Text>
                      )}
                      {isProjectAnalyzing(p) ? (
                        <Tag color="processing">Analisando… {projectProgress(p)}</Tag>
                      ) : p.prototype_url ? (
                        <Text type="secondary">Discovery + Protótipo</Text>
                      ) : (
                        <Text type="secondary">Somente Discovery</Text>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <ProjectFormModal
        open={modalOpen}
        mode="create"
        loading={creating}
        error={error}
        onCancel={closeModal}
        onSubmit={handleCreate}
      />
    </>
  );
}
