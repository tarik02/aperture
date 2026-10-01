import { useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";

type BrowserArgsEditorProps = {
  args: string[];
  onChange: (args: string[]) => void;
  disabled?: boolean;
};

export function BrowserArgsEditor({ args, onChange, disabled }: BrowserArgsEditorProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);

  useEffect(() => {
    if (pendingFocusIndex.current === null) {
      return;
    }
    inputRefs.current[pendingFocusIndex.current]?.focus();
    pendingFocusIndex.current = null;
  }, [args.length]);

  function updateArg(index: number, value: string) {
    onChange(args.map((arg, i) => (i === index ? value : arg)));
  }

  function removeArg(index: number) {
    onChange(args.filter((_, i) => i !== index));
  }

  function addArg() {
    pendingFocusIndex.current = args.length;
    onChange([...args, ""]);
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Browser args</FieldLabel>
        <Table>
          <TableHeader>
            <TableRow className="aperture:hover:bg-transparent">
              <TableHead className="aperture:h-7 aperture:px-1">Argument</TableHead>
              <TableHead className="aperture:h-7 aperture:w-8 aperture:px-1 aperture:text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add browser arg"
                  onClick={addArg}
                  disabled={disabled}
                >
                  <Plus />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {args.length === 0 ? (
              <TableRow className="aperture:hover:bg-transparent">
                <TableCell
                  colSpan={2}
                  className="aperture:px-1 aperture:py-1.5 aperture:text-muted-foreground"
                >
                  No extra args
                </TableCell>
              </TableRow>
            ) : (
              args.map((arg, index) => (
                <TableRow key={index} className="aperture:hover:bg-transparent">
                  <TableCell className="aperture:px-1 aperture:py-1">
                    <Input
                      ref={(element) => {
                        inputRefs.current[index] = element;
                      }}
                      value={arg}
                      onChange={(event) => updateArg(index, event.target.value)}
                      placeholder="--disable-gpu"
                      disabled={disabled}
                      className="aperture:h-7"
                    />
                  </TableCell>
                  <TableCell className="aperture:px-1 aperture:py-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove browser arg"
                      onClick={() => removeArg(index)}
                      disabled={disabled}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Field>
    </FieldGroup>
  );
}
