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
    <InputGroup className={cn("aperture:h-7 aperture:w-full aperture:sm:w-64", className)}>
      <InputGroupInput
        ref={inputRef}
        type="search"
        aria-keyshortcuts="Control+F Meta+F"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        // Each list page mounts its own search, so this focuses it after every page navigation.
        autoFocus
      />
      <InputGroupAddon align="inline-start">
        <Search />
      </InputGroupAddon>
    </InputGroup>
  );
}
