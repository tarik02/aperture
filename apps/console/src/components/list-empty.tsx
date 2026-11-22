import { Button } from "@aperture-browser/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { type LucideIcon, SearchX } from "lucide-react";

type ListEmptyProps = {
  icon: LucideIcon;
  /** What there is none of, in a few words. */
  title: string;
  /** What makes the first one, where whoever looks may: the page's own way to. */
  children?: React.ReactNode;
};

/**
 * What a list shows while there is nothing in it yet, in the room the list has. It is shown
 * once that is known, and not while the list is still asked for.
 */
export function ListEmpty({ icon: Icon, title, children }: ListEmptyProps) {
  return (
    <Empty data-console-empty="none">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {children === undefined || children === null || children === false ? null : (
        <EmptyContent>{children}</EmptyContent>
      )}
    </Empty>
  );
}

/** What a list shows where it has things and none is what it is narrowed to. */
export function ListNoMatch({ title, onClear }: { title: string; onClear: () => void }) {
  return (
    <Empty data-console-empty="no-match">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" data-console-clear-filters onClick={onClear}>
          Clear filters
        </Button>
      </EmptyContent>
    </Empty>
  );
}
