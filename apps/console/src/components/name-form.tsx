import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

type NameFormProps = {
  placeholder: string;
  label: string;
  pending: boolean;
  onSubmit: (name: string) => void;
};

/** Makes something that needs nothing but a name. */
export function NameForm({ placeholder, label, pending, onSubmit }: NameFormProps) {
  const [name, setName] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name.trim());
    setName("");
  };

  return (
    <form onSubmit={submit} className="aperture:flex aperture:items-center aperture:gap-2">
      <Input
        placeholder={placeholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="aperture:h-8 aperture:w-48"
      />
      <Button type="submit" size="sm" disabled={pending || name.trim() === ""}>
        <Plus />
        {label}
      </Button>
    </form>
  );
}
