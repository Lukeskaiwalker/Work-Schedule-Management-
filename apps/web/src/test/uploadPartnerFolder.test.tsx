/**
 * Uploading into a project's "Partnerportal" folder.
 *
 * What must hold: the project upload dialog says so whenever the target is
 * the partner folder — picked in the list OR typed as a new path; the
 * customer card's dialog never does (a customer folder of that name is not
 * shared); and the partner folder is never remembered as the default for
 * the next upload.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { UploadFilesDialog, type UploadFilesDialogProps } from "../components/files/UploadFilesDialog";
import { FileUploadModal } from "../components/modals/FileUploadModal";

const NOTE = /sehen die Partner dieses Projekts/;

function dialog(overrides: Partial<UploadFilesDialogProps> = {}) {
  const props: UploadFilesDialogProps = {
    open: true,
    folders: [
      { path: "Bilder", is_protected: false, portal_shared: false },
      { path: "Partnerportal", is_protected: false, portal_shared: true },
    ],
    selectedFolder: "Bilder",
    onFolderChange: vi.fn(),
    newFolderPath: "",
    onNewFolderPathChange: vi.fn(),
    onCreateFolder: vi.fn(),
    pendingFiles: [],
    busy: false,
    percent: null,
    phase: null,
    error: "",
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    canUseProtectedFolders: true,
    language: "de",
    ...overrides,
  };
  return render(<UploadFilesDialog {...props} />);
}

describe("the partner folder in the upload dialog", () => {
  it("warns for the picked partner folder and labels it in the list", () => {
    dialog({ selectedFolder: "Partnerportal", warnPartnerPortalFolder: true });
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Partnerportal — im Partnerportal sichtbar" })).toBeInTheDocument();
  });

  it("warns for a typed new path below the partner folder", () => {
    dialog({ selectedFolder: "Bilder", newFolderPath: "partnerportal/Dach", warnPartnerPortalFolder: true });
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("stays quiet for other folders, and in the customer card", () => {
    const { unmount } = dialog({ selectedFolder: "Bilder", warnPartnerPortalFolder: true });
    expect(screen.queryByText(NOTE)).toBeNull();
    unmount();
    dialog({ selectedFolder: "Partnerportal" });
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByRole("option", { name: "Partnerportal" })).toBeInTheDocument();
  });

  it("never keeps the partner folder as the next upload's default", () => {
    const setFileUploadFolder = vi.fn();
    const context = makeAppContextStub({
      overrides: {
        language: "de",
        fileUploadModalOpen: false,
        mainView: "project",
        activeProject: { id: 11 },
        projectTab: "files",
        fileUploadFolder: "Partnerportal/Pläne",
        setFileUploadFolder,
        projectFolders: [],
        fileUploadPendingFiles: [],
        setFileUploadPendingFiles: vi.fn(),
        fileUploadBusy: false,
        fileUploadPercent: null,
        fileUploadPhase: null,
        fileUploadError: "",
        newProjectFolderPath: "",
      },
    });
    render(
      <AppContext.Provider value={context as never}>
        <FileUploadModal />
      </AppContext.Provider>,
    );
    expect(setFileUploadFolder).toHaveBeenCalledWith("");
  });
});
