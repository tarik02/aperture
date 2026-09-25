import { SessionWorkbench } from "#/components/workbench/session-workbench.tsx";

type SessionDetailPageProps = {
  sessionId: string;
};

export function SessionDetailPage({ sessionId }: SessionDetailPageProps) {
  return <SessionWorkbench sessionId={sessionId} />;
}
