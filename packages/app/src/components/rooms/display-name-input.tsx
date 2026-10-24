import { memo, useCallback, useEffect, useRef } from "react";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

/**
 * Display-name input with programmatic echo (§4.5/§5.5): role presets fill the
 * name from the model side, and the editing surface — which owns its own
 * in-progress text and reads `initialValue` only once — is updated through
 * `replaceText` unless the change came from this input's own change events.
 * Shared by the create-room form and the mid-room member-add sheet.
 */
export const DisplayNameInput = memo(function DisplayNameInput({
  value,
  onChangeText,
  placeholder,
  size,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  size?: FieldControlSize;
  testID?: string;
}) {
  const inputRef = useRef<EditingTextInputHandle>(null);
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastReportedRef.current === value) {
      return;
    }
    inputRef.current?.replaceText(value);
  }, [value]);
  const handleChange = useCallback(
    (next: string) => {
      lastReportedRef.current = next;
      onChangeText(next);
    },
    [onChangeText],
  );
  return (
    <FormTextInput
      ref={inputRef}
      initialValue={value}
      onChangeText={handleChange}
      placeholder={placeholder}
      size={size}
      testID={testID}
    />
  );
});
