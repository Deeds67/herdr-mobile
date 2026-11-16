// Draws a mod's description (src/mods/description.ts) with native views.
// Text styles flow down to the strings inside; handlers call back into the mod.
import Ionicons from "@expo/vector-icons/Ionicons";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import type { UIElement, UINode } from "../../mods/description";
import { Asset } from "./Asset";
import { Swipe } from "./Swipe";

const TEXT_KEYS = new Set(["color", "fontSize", "fontWeight", "fontFamily", "fontStyle", "textDecorationLine", "lineHeight", "textAlign"]);
// In a scroll view these lay out the content, not the frame.
const CONTENT_KEYS = new Set(["padding", "paddingHorizontal", "paddingVertical", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "gap", "rowGap", "columnGap", "alignItems", "justifyContent", "flexDirection", "flexWrap"]);

export type Fire = (callback: number, event?: unknown) => void;

type Ctx = { text: TextStyle; lines?: number; fire: Fire };

function split(style: Record<string, any> | undefined) {
  const view: Record<string, any> = {};
  const text: Record<string, any> = {};
  for (const [k, v] of Object.entries(style ?? {})) (TEXT_KEYS.has(k) ? text : view)[k] = v;
  return { view, text };
}

function Spin({ ms, children }: { ms: number; children: ReactNode }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [ms, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

function Input({ n, ctx, style }: { n: UIElement; ctx: Ctx; style: any }) {
  const [text, setText] = useState(n.value ?? "");
  const last = useRef(n.value);
  if (n.value !== undefined && n.value !== last.current) {
    last.current = n.value;
    if (n.value !== text) setText(n.value);
  }
  return (
    <TextInput
      value={text}
      onChangeText={(t) => {
        setText(t);
        if (n.on?.change !== undefined) ctx.fire(n.on.change, { text: t });
      }}
      onSubmitEditing={() => n.on?.submit !== undefined && ctx.fire(n.on.submit, { text })}
      placeholder={n.placeholder}
      placeholderTextColor="#6e7681"
      autoFocus={n.autofocus}
      multiline={n.multiline}
      style={[ctx.text, style]}
      autoCorrect={false}
      autoCapitalize="none"
    />
  );
}

const Node = memo(function Node({ n, ctx }: { n: UINode; ctx: Ctx }) {
  if (typeof n === "string") {
    return (
      <Text style={[ctx.text, ctx.lines ? styles.shrink : null]} numberOfLines={ctx.lines}>
        {n}
      </Text>
    );
  }
  const { view, text } = split(n.s);
  if (n.t === "svg" || n.t === "img") {
    const el = <Asset path={n.path!} tint={n.t === "svg" ? ((text.color ?? ctx.text.color) as string) : undefined} size={text.fontSize ?? 16} style={view} />;
    return n.spin ? <Spin ms={n.spin}>{el}</Spin> : el;
  }
  if (n.t === "icon") {
    const el = <Ionicons name={n.name as any} size={view.width ?? text.fontSize ?? ctx.text.fontSize ?? 16} color={(text.color ?? ctx.text.color) as string} style={view} />;
    return n.spin ? <Spin ms={n.spin}>{el}</Spin> : el;
  }
  if (n.t === "input") return <Input n={n} ctx={{ ...ctx, text: { ...ctx.text, ...text } }} style={view} />;

  const inner: Ctx = Object.keys(text).length || n.lines ? { ...ctx, text: { ...ctx.text, ...text }, lines: n.lines ?? ctx.lines } : ctx;
  const kids = (n.k ?? []).map((c, i) => <Node key={typeof c === "object" && c.key ? c.key : i} n={c} ctx={inner} />);
  let el: ReactNode;
  if (n.scroll) {
    const frame: Record<string, any> = {};
    const content: Record<string, any> = {};
    for (const [k, v] of Object.entries(view)) (CONTENT_KEYS.has(k) ? content : frame)[k] = v;
    const refresh = n.on?.refresh;
    el = (
      <ScrollView
        horizontal={n.scroll === "x"}
        style={frame}
        contentContainerStyle={content}
        keyboardShouldPersistTaps="handled"
        refreshControl={refresh !== undefined ? <RefreshControl refreshing={false} onRefresh={() => ctx.fire(refresh)} tintColor="#8b949e" /> : undefined}
      >
        {kids}
      </ScrollView>
    );
  } else if (n.on?.click !== undefined || n.on?.long_press !== undefined) {
    const click = n.on.click;
    const long = n.on.long_press;
    el = (
      <Pressable
        style={({ pressed }) => [view, pressed && styles.pressed]}
        onPress={click !== undefined ? () => ctx.fire(click) : undefined}
        onLongPress={long !== undefined ? () => ctx.fire(long) : undefined}
        accessibilityRole="button"
      >
        {kids}
      </Pressable>
    );
  } else {
    el = <View style={view}>{kids}</View>;
  }
  return n.swipe ? (
    <Swipe actions={n.swipe} fire={ctx.fire}>
      {el}
    </Swipe>
  ) : (
    el
  );
});

export function Renderer({ node, fire, text }: { node: UINode; fire: Fire; text: TextStyle }) {
  return <Node n={node} ctx={{ text, fire }} />;
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
