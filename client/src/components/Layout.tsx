import { LogoutOutlined } from "@ant-design/icons";
import { Alert, Button, Flex, Layout as AntLayout, Menu, Space, Typography } from "antd";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAnalysis } from "../analysis/AnalysisContext";
import { useAuth } from "../auth/AuthContext";
import { ExtrakLogo } from "./ExtrakLogo";

const { Header, Content } = AntLayout;
const { Text } = Typography;

export function Layout() {
  const { email, isAdmin, signOut } = useAuth();
  const { jobs, completion, dismissCompletion } = useAnalysis();
  const location = useLocation();

  const runningJobs = Object.values(jobs).filter((j) => j.status === "running");

  const menuItems = [
    { key: "/", label: <NavLink to="/">Projetos</NavLink> },
    ...(isAdmin
      ? [{ key: "/admin", label: <NavLink to="/admin">Admin</NavLink> }]
      : []),
  ];

  const selectedKey =
    menuItems.find((item) =>
      item.key === "/"
        ? location.pathname === "/"
        : location.pathname.startsWith(item.key)
    )?.key ?? "/";

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "0 24px",
          borderBottom: "1px solid #e6e6e8",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <ExtrakLogo to="/" height={26} />

        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey]}
          items={menuItems}
          style={{ flex: 1, minWidth: 0, borderBottom: "none" }}
        />

        <Space size="middle" wrap>
          {runningJobs.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {runningJobs.length} análise(s) em andamento
            </Text>
          )}
          {email && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {email}
            </Text>
          )}
          <Button icon={<LogoutOutlined />} onClick={signOut}>
            Sair
          </Button>
        </Space>
      </Header>

      {completion && (
        <Alert
          type="success"
          showIcon
          banner
          message={
            <Flex align="center" gap={8} wrap="wrap">
              <span>
                Análise concluída: <strong>{completion.projectName}</strong>
              </span>
              <Link
                to={`/projects/${completion.projectId}`}
                onClick={dismissCompletion}
              >
                Ver gaps
              </Link>
              <Button type="link" size="small" onClick={dismissCompletion}>
                Fechar
              </Button>
            </Flex>
          }
        />
      )}

      <Content style={{ padding: "24px", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        <Outlet />
      </Content>
    </AntLayout>
  );
}
