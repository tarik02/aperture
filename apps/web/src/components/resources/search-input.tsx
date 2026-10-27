import { Search } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { cn } from "@aperture-browser/ui/utils";
import { usePageSearchShortcut } from "#/hooks/use-page-search-shortcut.ts";

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  const inputRef = usePageSearchShortcut();

  return (
    <InputGroup
      className={cn("aperture:h-8 aperture:w-full aperture:min-w-0 aperture:max-w-80", className)}
    >
      <InputGroupInput
        ref={inputRef}
        type="search"
        aria-keyshortcuts="Control+F Meta+F"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <InputGroupAddon align="inline-start">
        <Search />
      </InputGroupAddon>
    </InputGroup>
  );
}
