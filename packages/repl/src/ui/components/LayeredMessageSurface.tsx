import React, { useCallback, useMemo } from "react";
import type {
  TranscriptRenderModel,
  TranscriptRow,
} from "../utils/transcript-layout.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";

function buildLayeredModels(
  model: TranscriptRenderModel,
): {
  stableModel: TranscriptRenderModel;
  previewModel?: TranscriptRenderModel;
  previewRows: TranscriptRow[];
  previewRowKeySet: ReadonlySet<string>;
} {
  const previewRows = model.previewRows;
  const previewSections = model.previewSections;
  const previewRowKeySet = new Set(previewRows.map((row) => row.key));

  return {
    stableModel: {
      ...model,
      previewSections: [],
      previewRows: [],
    },
    previewModel: previewRows.length > 0
      ? {
          staticSections: [],
          sections: [],
          rows: [],
          previewSections: [...previewSections],
          previewRows: [...previewRows],
        }
      : undefined,
    previewRows,
    previewRowKeySet,
  };
}

export const LayeredMessageSurface: React.FC<MessageListProps> = (props) => {
  const layered = useMemo(
    () => props.transcriptModel
      ? buildLayeredModels(props.transcriptModel)
      : undefined,
    [props.transcriptModel],
  );

  const splitVisibleRowsOverride = useMemo(() => {
    if (!layered || !props.visibleRowsOverride) {
      return undefined;
    }

    const stableRows: TranscriptRow[] = [];
    const previewRows: TranscriptRow[] = [];

    for (const row of props.visibleRowsOverride) {
      if (layered.previewRowKeySet.has(row.key)) {
        previewRows.push(row);
      } else {
        stableRows.push(row);
      }
    }

    return {
      stableRows,
      previewRows,
    };
  }, [layered, props.visibleRowsOverride]);

  const handleMetricsChange = useCallback<NonNullable<MessageListProps["onMetricsChange"]>>((metrics) => {
    if (!layered) {
      props.onMetricsChange?.(metrics);
      return;
    }

    props.onMetricsChange?.({
      ...metrics,
      scrollHeight: metrics.scrollHeight + layered.previewRows.length,
    });
  }, [layered, props]);

  const handleVisibleRowsChange = useCallback<NonNullable<MessageListProps["onVisibleRowsChange"]>>((snapshot) => {
    if (!layered) {
      props.onVisibleRowsChange?.(snapshot);
      return;
    }

    const visiblePreviewRows = splitVisibleRowsOverride?.previewRows ?? layered.previewRows;
    props.onVisibleRowsChange?.({
      rows: [...snapshot.rows, ...visiblePreviewRows],
      allRows: [...snapshot.allRows, ...layered.previewRows],
    });
  }, [layered, props, splitVisibleRowsOverride?.previewRows]);

  if (!layered || !layered.previewModel) {
    return <MessageList {...props} />;
  }

  const stableVisibleRowsOverride = splitVisibleRowsOverride?.stableRows;
  const previewVisibleRowsOverride = splitVisibleRowsOverride?.previewRows;

  return (
    <>
      <MessageList
        {...props}
        transcriptModel={layered.stableModel}
        visibleRowsOverride={stableVisibleRowsOverride}
        onMetricsChange={handleMetricsChange}
        onVisibleRowsChange={handleVisibleRowsChange}
      />
      <MessageList
        {...props}
        items={[]}
        isLoading
        transcriptModel={layered.previewModel}
        visibleRowsOverride={previewVisibleRowsOverride}
        onMetricsChange={undefined}
        onVisibleRowsChange={undefined}
        rendererWindow={undefined}
        scrollOffset={0}
        windowed={false}
      />
    </>
  );
};
