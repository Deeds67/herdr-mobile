import { useMemo, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture, useTapGesture, type PanGestureConfig, type TapGestureConfig } from "react-native-gesture-handler";
import Animated, { Easing, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { UIElement } from "../../mods/description";
import type { Fire } from "./Renderer";

type Action = NonNullable<UIElement["swipe"]>[number];

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

export function Swipe({ actions, fire, children }: { actions: Action[]; fire: Fire; children: ReactNode }) {
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
  const armed = useSharedValue(0);
  const tapEnabled = useDerivedValue(() => rest.get() !== 0);

  useAnimatedReaction(
    () => width.get() > 0 && Math.abs(x.get()) >= width.get() / 2,
    (now, before) => {
      if (now !== before) armed.set(withTiming(now ? 1 : 0, ARM));
    },
  );

  const close = useMemo(
    () =>
      (animation: number = settleTo(0)) => {
        "worklet";
        rest.set(0);
        x.set(animation);
      },
    [rest, x],
  );

  const panConfig = useMemo(
    (): PanGestureConfig => ({
      activeOffsetX: [-10, 10],
      failOffsetY: [-10, 10],
      onActivate: () => {
        "worklet";
        start.set(x.get());
      },
      onUpdate: (e) => {
        "worklet";
        const w = width.get();
        x.set(Math.max(hasLeft ? -w : 0, Math.min(hasRight ? w : 0, start.get() + e.translationX)));
      },
      onDeactivate: (e) => {
        "worklet";
        const w = width.get();
        const v = x.get();
        if (e.canceled) {
          x.set(settleTo(rest.get() * ACTION));
          return;
        }
        const side = Math.sign(v);
        if (side !== 0 && w > 0 && Math.abs(v) >= w / 2) {
          close(
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
        x.set(settleTo(to * ACTION, e.velocityX));
      },
    }),
    [close, hasLeft, hasRight, rest, run, start, width, x],
  );
  const pan = usePanGesture(panConfig);

  const tapConfig = useMemo(
    (): TapGestureConfig => ({
      enabled: tapEnabled,
      shouldCancelWhenOutside: true,
      onActivate: () => {
        "worklet";
        close();
      },
    }),
    [close, tapEnabled],
  );
  const tap = useTapGesture(tapConfig);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
    pointerEvents: rest.get() === 0 ? "auto" : "box-only",
  }));

  const press = (side: number) => {
    close();
    run(side);
  };

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.row} onLayout={(e) => width.set(e.nativeEvent.layout.width)}>
        {right && <Panel action={right} side={1} x={x} width={width} armed={armed} onPress={() => press(1)} />}
        {left && <Panel action={left} side={-1} x={x} width={width} armed={armed} onPress={() => press(-1)} />}
        <GestureDetector gesture={tap}>
          <Animated.View style={rowStyle}>{children}</Animated.View>
        </GestureDetector>
      </View>
    </GestureDetector>
  );
}

function Panel({ action, side, x, width, armed, onPress }: { action: Action; side: 1 | -1; x: SharedValue<number>; width: SharedValue<number>; armed: SharedValue<number>; onPress: () => void }) {
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() - side * width.get() }],
    pointerEvents: side * x.get() > 0 ? "auto" : "none",
  }));
  const labelStyle = useAnimatedStyle(() => {
    const a = armed.get();
    const v = x.get();
    return { transform: [{ translateX: side > 0 ? a * (v - ACTION) - v + width.get() : (a - 1) * (ACTION + v) }] };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: action.color ?? "#f85149" }, panelStyle]}>
      <Pressable accessibilityRole="button" accessibilityLabel={action.label} onPress={onPress} style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.label, labelStyle]}>
          <Text style={styles.labelText} numberOfLines={1}>
            {action.label}
          </Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { overflow: "hidden" },
  label: { position: "absolute", top: 0, bottom: 0, left: 0, width: ACTION, alignItems: "center", justifyContent: "center" },
  labelText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
});
