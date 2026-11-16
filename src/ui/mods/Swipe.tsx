import { useMemo, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { Easing, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { UIElement } from "../../mods/description";
import type { Fire } from "./Renderer";

type Actions = NonNullable<UIElement["swipe"]>;
type Action = Actions[number];

const ACTION = 88;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const SLIDE_OUT = { duration: 200, easing: EASE_OUT, reduceMotion: ReduceMotion.System };
const ARM = { duration: 150, easing: EASE_OUT, reduceMotion: ReduceMotion.System };
const RETURN_AFTER = 400;

function settleTo(to: number, velocity = 0) {
  "worklet";
  return withSpring(to, { duration: 400, dampingRatio: 0.8, velocity, overshootClamping: true, reduceMotion: ReduceMotion.System });
}

function project(velocity: number) {
  "worklet";
  return ((velocity / 1000) * 0.998) / (1 - 0.998);
}

export function Swipe({ actions, fire, children }: { actions: Actions; fire: Fire; children: ReactNode }) {
  const right = actions.find((a) => a.d === "right");
  const left = actions.find((a) => a.d === "left");
  const latest = useRef({ right, left, fire });
  latest.current = { right, left, fire };
  const run = useRef((side: number) => {
    const a = side > 0 ? latest.current.right : latest.current.left;
    if (a) latest.current.fire(a.a);
  }).current;

  const hasRight = right !== undefined;
  const hasLeft = left !== undefined;
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const width = useSharedValue(0);
  const rest = useSharedValue(0);
  const tapEnabled = useSharedValue(false);
  const armed = useSharedValue(0);

  useAnimatedReaction(
    () => width.get() > 0 && Math.abs(x.get()) >= width.get() / 2,
    (now, before) => {
      if (now !== before) armed.set(withTiming(now ? 1 : 0, ARM));
    },
  );

  const panConfig = useMemo(
    () => ({
      activeOffsetX: [-10, 10] as [number, number],
      failOffsetY: [-10, 10] as [number, number],
      onActivate: () => {
        "worklet";
        start.set(x.get());
      },
      onUpdate: (e: { translationX: number }) => {
        "worklet";
        const w = width.get();
        x.set(Math.max(hasLeft ? -w : 0, Math.min(hasRight ? w : 0, start.get() + e.translationX)));
      },
      onDeactivate: (e: { translationX: number; velocityX: number; canceled: boolean }) => {
        "worklet";
        const w = width.get();
        const v = x.get();
        if (e.canceled) {
          x.set(settleTo(rest.get() * ACTION));
          return;
        }
        const side = v > 0 ? 1 : v < 0 ? -1 : 0;
        if (side !== 0 && w > 0 && Math.abs(v) >= w / 2) {
          rest.set(0);
          tapEnabled.set(false);
          x.set(
            withTiming(side * w, SLIDE_OUT, (done) => {
              if (!done) return;
              scheduleOnRN(run, side);
              x.set(withDelay(RETURN_AFTER, settleTo(0)));
            }),
          );
          return;
        }
        const p = v + project(e.velocityX);
        const to = hasRight && p > ACTION / 2 ? 1 : hasLeft && p < -ACTION / 2 ? -1 : 0;
        rest.set(to);
        tapEnabled.set(to !== 0);
        x.set(settleTo(to * ACTION, e.velocityX));
      },
    }),
    [hasLeft, hasRight, rest, run, start, tapEnabled, width, x],
  );
  const pan = usePanGesture(panConfig);

  const tapConfig = useMemo(
    () => ({
      enabled: tapEnabled,
      shouldCancelWhenOutside: true,
      onActivate: () => {
        "worklet";
        rest.set(0);
        tapEnabled.set(false);
        x.set(settleTo(0));
      },
    }),
    [rest, tapEnabled, x],
  );
  const tap = useTapGesture(tapConfig);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
    pointerEvents: rest.get() === 0 ? "auto" : "box-only",
  }));
  const leftPanel = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() - width.get() }],
    pointerEvents: x.get() > 0 ? "auto" : "none",
  }));
  const leftLabel = useAnimatedStyle(() => ({
    transform: [{ translateX: armed.get() * (x.get() - ACTION) - (x.get() - width.get()) }],
  }));
  const rightPanel = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() + width.get() }],
    pointerEvents: x.get() < 0 ? "auto" : "none",
  }));
  const rightLabel = useAnimatedStyle(() => {
    const w = width.get();
    const a = armed.get();
    return { transform: [{ translateX: (1 - a) * (w - ACTION) + a * (w + x.get()) - (x.get() + w) }] };
  });

  const press = (side: number) => {
    rest.set(0);
    tapEnabled.set(false);
    x.set(settleTo(0));
    run(side);
  };
  const panel = (a: Action, side: number) => (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: a.color ?? "#f85149" }, side > 0 ? leftPanel : rightPanel]}>
      <Pressable accessibilityRole="button" accessibilityLabel={a.label} onPress={() => press(side)} style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.label, side > 0 ? leftLabel : rightLabel]}>
          <Text style={styles.labelText} numberOfLines={1}>
            {a.label}
          </Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.row} onLayout={(e) => width.set(e.nativeEvent.layout.width)}>
        {right && panel(right, 1)}
        {left && panel(left, -1)}
        <GestureDetector gesture={tap}>
          <Animated.View style={rowStyle}>{children}</Animated.View>
        </GestureDetector>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: { overflow: "hidden" },
  label: { position: "absolute", top: 0, bottom: 0, left: 0, width: ACTION, alignItems: "center", justifyContent: "center" },
  labelText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
});
