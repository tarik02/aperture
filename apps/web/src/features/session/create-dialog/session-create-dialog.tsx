import { useForm, useStore } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { flattenInfinitePages } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@aperture-browser/ui/components/combobox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import {
  TagEditor,
  entriesToTags,
  type TagEntry,
} from "@aperture-browser/ui/components/tag-editor";
import { cn } from "@aperture-browser/ui/utils";
import { BrowserArgsEditor } from "#/components/sessions/browser-args-editor.tsx";
import { useBrowserChannelsQuery } from "#/features/browser/browser.queries.ts";
import {
  emptyProxyDraft,
  hasProxyDraftErrors,
  proxyConfigFromDraft,
  validateProxyDraft,
  type ProxyDraft,
} from "#/features/proxy/proxy-config.ts";
import { ProxyEditor } from "#/features/proxy/proxy-editor.tsx";
import { useCreateSessionMutation } from "#/features/session/session.mutations.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";

export interface SessionCreateRequest {
  readonly baseSnapshot?: string | null;
}

type SessionCreateDialogProps = {
  request: SessionCreateRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
};

export function SessionCreateDialog({
  request,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: SessionCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="aperture:sm:max-w-xl">
        {request ? (
          <SessionCreateForm request={request} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface SnapshotOption {
  readonly value: string | null;
  readonly label: string;
  readonly description: string;
}

const noSnapshot: SnapshotOption = {
  value: null,
  label: "None",
  description: "Blank browser, no saved logins",
};

const formId = "session-create-form";

function SessionCreateForm({
  request,
  onDone,
}: {
  request: SessionCreateRequest;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const channelsQuery = useBrowserChannelsQuery();
  const snapshotsQuery = useSnapshotsInfiniteQuery({ limit: 100 });
  const mutation = useCreateSessionMutation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const channels = channelsQuery.data?.channels ?? [];
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );
  const snapshotOptions = useMemo<SnapshotOption[]>(() => {
    const options = snapshots.map((snapshot) => ({
      value: snapshot.name,
      label: snapshot.name,
      description: snapshot.description ?? "No description",
    }));
    // A snapshot picked from a longer list than the first page loaded here.
    const requested = request.baseSnapshot;
    if (requested && !options.some((option) => option.value === requested)) {
      options.unshift({ value: requested, label: requested, description: "" });
    }
    return [noSnapshot, ...options];
  }, [request.baseSnapshot, snapshots]);

  const [defaultValues] = useState(() => ({
    label: "",
    channel: "",
    baseSnapshot: request.baseSnapshot ?? null,
    browserArgs: [] as string[],
    tagEntries: [] as TagEntry[],
    proxy: emptyProxyDraft() as ProxyDraft,
  }));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const channel = value.channel || channels[0]?.name;
      if (!channel) {
        return;
      }
      const proxy = proxyConfigFromDraft(value.proxy);
      const result = await mutation.mutateAsync({
        label: value.label.trim() || null,
        browser: {
          channel,
          args: value.browserArgs.map((arg) => arg.trim()).filter(Boolean),
        },
        baseSnapshotName: value.baseSnapshot,
        tags: entriesToTags(value.tagEntries),
        proxy: Object.keys(proxy).length > 0 ? proxy : undefined,
      });
      onDone();
      void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: result.session.id } });
    },
  });

  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const proxyDraft = useStore(form.store, (state) => state.values.proxy);
  const proxyErrors = useMemo(() => validateProxyDraft(proxyDraft), [proxyDraft]);
  const proxyInvalid = hasProxyDraftErrors(proxyErrors);

  return (
    <form
      id={formId}
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New session</DialogTitle>
      </DialogHeader>
      <FieldGroup>
        <form.Field name="label">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="session-label">Label</FieldLabel>
              <Input
                id="session-label"
                autoFocus
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Optional"
                disabled={submitting}
                autoComplete="off"
              />
            </Field>
          )}
        </form.Field>

        {channels.length > 1 ? (
          <form.Field name="channel">
            {(field) => (
              <Field>
                <FieldLabel>Browser</FieldLabel>
                <Select
                  items={channels.map((channel) => ({ value: channel.name, label: channel.name }))}
                  value={field.state.value || channels[0]?.name}
                  onValueChange={(value) => field.handleChange(value ?? "")}
                  disabled={submitting}
                >
                  <SelectTrigger className="aperture:w-full">
                    <SelectValue placeholder="Browser" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {channels.map((channel) => (
                        <SelectItem key={channel.name} value={channel.name}>
                          {channel.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
        ) : null}

        {snapshotOptions.length > 1 ? (
          <form.Field name="baseSnapshot">
            {(field) => {
              const selected =
                snapshotOptions.find((option) => option.value === field.state.value) ?? noSnapshot;
              return (
                <Field>
                  <FieldLabel>Snapshot</FieldLabel>
                  <Combobox
                    items={snapshotOptions}
                    value={selected}
                    itemToStringLabel={(option: SnapshotOption) => option.label}
                    isItemEqualToValue={(left: SnapshotOption, right: SnapshotOption) =>
                      left.value === right.value
                    }
                    onValueChange={(option: SnapshotOption | null) =>
                      field.handleChange(option?.value ?? null)
                    }
                  >
                    <ComboboxTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="aperture:w-full aperture:min-w-0 aperture:justify-between aperture:font-normal"
                          disabled={submitting}
                        />
                      }
                    >
                      <span
                        className={cn(
                          "aperture:min-w-0 aperture:truncate",
                          selected.value === null && "aperture:text-muted-foreground",
                        )}
                      >
                        {selected.value === null
                          ? "None — Blank browser, no saved logins"
                          : selected.label}
                      </span>
                    </ComboboxTrigger>
                    <ComboboxContent align="start" className="aperture:w-(--anchor-width)">
                      <ComboboxInput
                        placeholder="Search snapshots"
                        showTrigger={false}
                        className="aperture:w-auto"
                      />
                      <ComboboxEmpty>No snapshots match.</ComboboxEmpty>
                      <ComboboxList>
                        {(option: SnapshotOption) => (
                          <ComboboxItem key={option.value ?? ""} value={option}>
                            <span className="aperture:grid aperture:min-w-0">
                              <span className="aperture:truncate">{option.label}</span>
                              <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                                {option.description}
                              </span>
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <FieldDescription>
                    The session starts with a copy of the snapshot. Changes made in the session do
                    not change the snapshot.
                  </FieldDescription>
                </Field>
              );
            }}
          </form.Field>
        ) : null}

        <FieldSeparator />
        <button
          type="button"
          className="aperture:flex aperture:items-center aperture:gap-1.5 aperture:text-sm aperture:font-medium aperture:text-muted-foreground aperture:hover:text-foreground"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <ChevronRight
            className={cn(
              "aperture:size-4 aperture:transition-transform",
              advancedOpen && "aperture:rotate-90",
            )}
          />
          Proxy, browser arguments and tags
        </button>
        {advancedOpen ? (
          <>
            <form.Field name="proxy">
              {(field) => (
                <ProxyEditor
                  value={field.state.value}
                  onChange={field.handleChange}
                  errors={proxyErrors}
                  disabled={submitting}
                />
              )}
            </form.Field>
            <form.Field name="browserArgs">
              {(field) => (
                <BrowserArgsEditor
                  args={field.state.value}
                  onChange={field.handleChange}
                  disabled={submitting}
                />
              )}
            </form.Field>
            <form.Field name="tagEntries">
              {(field) => (
                <TagEditor
                  entries={field.state.value}
                  onChange={field.handleChange}
                  disabled={submitting}
                />
              )}
            </form.Field>
          </>
        ) : null}
      </FieldGroup>
      {mutation.error ? (
        <p className="aperture:text-sm aperture:text-destructive">{mutation.error.message}</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={submitting || channelsQuery.isLoading || channels.length === 0 || proxyInvalid}
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          Start session
        </Button>
      </DialogFooter>
    </form>
  );
}
