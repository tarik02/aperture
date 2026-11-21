import { useSidebar } from "@aperture-browser/ui/components/sidebar";
import { useCallback } from "react";

/**
 * Closes the sidebar where it is a drawer over the page, as on a phone: for what in it
 * leads elsewhere or opens a dialog, which the drawer would otherwise stay over.
 */
export function useCloseDrawer() {
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
}
