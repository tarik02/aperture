"use client";

import { useMemo } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";
import { Label } from "./label.tsx";
import { Separator } from "./separator.tsx";

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "aperture:flex aperture:flex-col aperture:gap-4 aperture:has-[>[data-slot=checkbox-group]]:gap-3 aperture:has-[>[data-slot=radio-group]]:gap-3",
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "aperture:mb-1.5 aperture:font-medium aperture:data-[variant=label]:text-sm aperture:data-[variant=legend]:text-base",
        className,
      )}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "aperture:group/field-group aperture:@container/field-group aperture:flex aperture:w-full aperture:flex-col aperture:gap-5 aperture:data-[slot=checkbox-group]:gap-3 aperture:*:data-[slot=field-group]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva(
  "aperture:group/field aperture:flex aperture:w-full aperture:gap-2 aperture:data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: "aperture:flex-col aperture:*:w-full aperture:[&>.sr-only]:w-auto",
        horizontal:
          "aperture:flex-row aperture:items-center aperture:has-[>[data-slot=field-content]]:items-start aperture:*:data-[slot=field-label]:flex-auto aperture:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        responsive:
          "aperture:flex-col aperture:*:w-full aperture:@md/field-group:flex-row aperture:@md/field-group:items-center aperture:@md/field-group:*:w-auto aperture:@md/field-group:has-[>[data-slot=field-content]]:items-start aperture:@md/field-group:*:data-[slot=field-label]:flex-auto aperture:[&>.sr-only]:w-auto aperture:@md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  },
);

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "aperture:group/field-content aperture:flex aperture:flex-1 aperture:flex-col aperture:gap-0.5 aperture:leading-snug",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        "aperture:group/field-label aperture:peer/field-label aperture:flex aperture:w-fit aperture:gap-2 aperture:leading-snug aperture:group-data-[disabled=true]/field:opacity-50 aperture:has-data-checked:border-primary/30 aperture:has-data-checked:bg-primary/5 aperture:has-[>[data-slot=field]]:rounded-lg aperture:has-[>[data-slot=field]]:border aperture:*:data-[slot=field]:p-2.5 aperture:dark:has-data-checked:border-primary/20 aperture:dark:has-data-checked:bg-primary/10",
        "aperture:has-[>[data-slot=field]]:w-full aperture:has-[>[data-slot=field]]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "aperture:flex aperture:w-fit aperture:items-center aperture:gap-2 aperture:text-sm aperture:font-medium aperture:group-data-[disabled=true]/field:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "aperture:text-left aperture:text-sm aperture:leading-normal aperture:font-normal aperture:text-muted-foreground aperture:group-has-data-horizontal/field:text-balance aperture:[[data-variant=legend]+&]:-mt-1.5",
        "aperture:last:mt-0 aperture:nth-last-2:-mt-1",
        "aperture:[&>a]:underline aperture:[&>a]:underline-offset-4 aperture:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        "aperture:-my-2 aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:group-data-[variant=outline]/field-group:-mb-2",
        className,
      )}
      {...props}
    >
      <Separator className="aperture:flex-1" />
      {children && (
        <>
          <span
            className="aperture:shrink-0 aperture:text-muted-foreground"
            data-slot="field-separator-content"
          >
            {children}
          </span>
          <Separator className="aperture:flex-1" aria-hidden />
        </>
      )}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()];

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul className="aperture:ml-4 aperture:flex aperture:list-disc aperture:flex-col aperture:gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn("aperture:text-sm aperture:font-normal aperture:text-destructive", className)}
      {...props}
    >
      {content}
    </div>
  );
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
};
