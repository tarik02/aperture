import type { LucideIcon } from "lucide-react";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";

type PagePlaceholderProps = {
  title: string;
  icon: LucideIcon;
};

export function PagePlaceholder({ title, icon: Icon }: PagePlaceholderProps) {
  return (
    <Empty className="min-h-[50vh] border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
