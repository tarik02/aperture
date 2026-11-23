import { toast } from "sonner";

/** Copies text, and says so where the browser did not let it. Whether it was copied. */
export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error("The browser did not let this page copy.");
    return false;
  }
};
