import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";

export interface RoomInterjectionComposerHandle {
  focus(): void;
}

/**
 * Local draft survives RPC failure; the input clears only after the daemon
 * accepts the interjection and returns a snapshot.
 */
export const RoomInterjectionComposer = forwardRef<
  RoomInterjectionComposerHandle,
  {
    room: RoomRecord;
    onSubmit: (text: string) => Promise<void>;
    submitting: boolean;
  }
>(function RoomInterjectionComposer({ room, onSubmit, submitting }, ref) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [draft, setDraft] = useState("");

  const interjectable =
    room.status === "discussing" || room.status === "interrupted" || room.status === "closing";
  const disabledReason = !interjectable
    ? t("rooms.composer.waitingForDiscussion", { status: room.status })
    : null;

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text || submitting || disabledReason) {
      return;
    }
    try {
      await onSubmit(text);
      setDraft("");
      inputRef.current?.replaceText("");
    } catch {
      // Keep the draft; the parent surfaces the action error.
    }
  }, [disabledReason, draft, onSubmit, submitting]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  return (
    <View style={styles.container} testID="room-interjection-composer">
      <View style={styles.inputRow}>
        <FormTextInput
          ref={inputRef}
          initialValue=""
          onChangeText={setDraft}
          placeholder={disabledReason ?? t("rooms.composer.placeholder")}
          size={isCompact ? "md" : "sm"}
          multiline
          editable={!disabledReason}
          testID="room-interjection-input"
          style={styles.input}
        />
        <Button
          variant="default"
          size="md"
          onPress={handleSubmit}
          disabled={!draft.trim() || submitting || Boolean(disabledReason)}
          loading={submitting}
          testID="room-interjection-send"
          accessibilityLabel={t("rooms.actions.send")}
        >
          {t("rooms.actions.send")}
        </Button>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    // The panel spans the whole pane, so an unconstrained row hugs the left
    // edge on wide screens. Cap the readable width and center it instead;
    // on narrow screens the cap never binds and the row stays full-width.
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  input: {
    flex: 1,
    // A multiline field without a floor collapses to one short line; give it
    // room to breathe while still growing with typed content.
    minHeight: 44,
  },
}));
