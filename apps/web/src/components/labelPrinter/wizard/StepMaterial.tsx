/**
 * Wizard step 2 "Material und Sensor" (docs/LABEL_PRINTER_CALIBRATION.md §7.6):
 * the profile form, saved before anything is sent to the printer — apply and
 * the checklist read the saved profile, not the form. Unchanged → no PUT.
 */
import { useAppContext } from "../../../context/AppContext";
import type { LabelMaterial, LabelPrinterSettings } from "../../../types/labelPrinter";
import { LabelMaterialForm } from "../LabelMaterialForm";

export interface StepMaterialProps {
  material: LabelMaterial;
  revision: number;
  onSaved: (settings: LabelPrinterSettings | null) => void;
  onReload: () => void;
}

export function StepMaterial({ material, revision, onSaved, onReload }: StepMaterialProps) {
  const { language } = useAppContext();
  const de = language === "de";
  return (
    <LabelMaterialForm
      key={material.id}
      material={material}
      revision={revision}
      submitLabel={de ? "Speichern und weiter" : "Save and continue"}
      onSaved={onSaved}
      onReload={onReload}
    />
  );
}
