import { SessionWorkbench } from "#/components/workbench/session-workbench.tsx";

type SessionDetailPageProps = {
  sessionId: string;
  forceCDPMedia: boolean;
};

export function SessionDetailPage({ sessionId, forceCDPMedia }: SessionDetailPageProps) {
  return <SessionWorkbench sessionId={sessionId} forceCDPMedia={forceCDPMedia} />;
}
