import React, { useLayoutEffect, useMemo, useState } from "react";

interface StaticProps<Item> {
  items: readonly Item[];
  children: (item: Item, index: number) => React.ReactNode;
  style?: Record<string, unknown>;
}

export default function Static<Item>({
  items,
  children: render,
  style: customStyle,
}: StaticProps<Item>) {
  const [index, setIndex] = useState(0);
  const itemsToRender = useMemo(() => items.slice(index), [items, index]);

  useLayoutEffect(() => {
    setIndex(items.length);
  }, [items.length]);

  const children = itemsToRender.map((item, itemIndex) => render(item, index + itemIndex));
  const style = useMemo(() => ({
    position: "absolute",
    flexDirection: "column",
    ...customStyle,
  }), [customStyle]);

  return React.createElement(
    "ink-box",
    { internal_static: true, style },
    children,
  );
}
