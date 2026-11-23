import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";

interface AlarmItem {
  id: string;
  timeLabel: string;
  targetDateISO: string;
  label: string;
  isTomorrow: boolean;
  triggered?: boolean;
  notificationId?: string;
}

type AssistantPhase =
  | "idle"
  | "waiting_wake_word"
  | "waking_up"
  | "listening_command"
  | "processing";

const ALARMS_STORAGE_KEY = "@ialarm_alarms_v1";
const USER_NAME_STORAGE_KEY = "@ialarm_user_name_v1";
const ALARM_CHANNEL_ID = "ialarm_alarms_channel_v2";

const SLIDER_TRACK_WIDTH = 300;
const SLIDER_THUMB_SIZE = 54;
const SLIDER_PADDING = 5;
const SLIDER_MAX_TRAVEL =
  SLIDER_TRACK_WIDTH - SLIDER_THUMB_SIZE - SLIDER_PADDING * 2;

const SPANISH_NUMBER_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  treinta: 30,
  cuarenta: 40,
  "cuarenta y cinco": 45,
  cincuenta: 50,
  sesenta: 60,
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function configureAlarmNotifications(): Promise<void> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: "Alarmas de IAlarm",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400],
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) {
      await Notifications.requestPermissionsAsync();
    }
  } catch (err) {
    console.warn(
      "[IAlarm Notifications] Error configurando permisos/canal:",
      err,
    );
  }
}

async function scheduleAlarmNotification(
  alarm: Omit<AlarmItem, "notificationId">,
): Promise<string | undefined> {
  try {
    const targetDate = new Date(alarm.targetDateISO);
    if (
      Number.isNaN(targetDate.getTime()) ||
      targetDate.getTime() <= Date.now()
    ) {
      return undefined;
    }

    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `⏰ ${alarm.label}`,
        body: `Es hora de tu alarma "${alarm.label}" (${alarm.timeLabel}).`,
        data: { alarmId: alarm.id },
      },
      trigger:
        Platform.OS === "android"
          ? {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: targetDate,
              channelId: ALARM_CHANNEL_ID,
            }
          : {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: targetDate,
            },
    });

    return notificationId;
  } catch (err) {
    console.warn("[IAlarm Notifications] Error programando notificación:", err);
    return undefined;
  }
}

async function cancelAlarmNotification(notificationId?: string): Promise<void> {
  if (!notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch (err) {
    console.warn("[IAlarm Notifications] Error cancelando notificación:", err);
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9:\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceSpanishNumberWords(text: string): string {
  let result = ` ${text} `;

  result = result.replace(/\bveinti\s+([a-z]+)\b/g, (_m, unit) => {
    const mapUnit: Record<string, number> = {
      uno: 21,
      un: 21,
      una: 21,
      dos: 22,
      tres: 23,
      cuatro: 24,
      cinco: 25,
      seis: 26,
      siete: 27,
      ocho: 28,
      nueve: 29,
    };
    return mapUnit[unit] ? ` ${mapUnit[unit]} ` : ` veinti${unit} `;
  });

  const entries = Object.entries(SPANISH_NUMBER_WORDS).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [word, num] of entries) {
    const regex = new RegExp(`\\b${word}\\b`, "g");
    result = result.replace(regex, ` ${num} `);
  }

  return result.replace(/\s+/g, " ").trim();
}

function containsWakeWord(rawText: string): boolean {
  const clean = normalizeText(rawText);
  return /\balarmas?\b/.test(clean);
}

function containsDeactivateCommand(rawText: string): boolean {
  const clean = normalizeText(rawText);
  return /\b(desactivate|desactivarte|desactiva|apagate|apaga|pausate|pausar|silencio)\b/.test(
    clean,
  );
}

function containsDeleteCommand(rawText: string): boolean {
  const clean = normalizeText(rawText);
  return /\belimin\w*\b/.test(clean);
}

function extractDeleteTarget(rawText: string): {
  deleteAll: boolean;
  query: string;
} {
  const clean = normalizeText(rawText);

  if (/\belimin\w*\s+(?:todas|todo)\b/.test(clean)) {
    return { deleteAll: true, query: "" };
  }

  const afterVerbMatch = clean.match(
    /\belimin\w*\s+(?:la\s+|el\s+|las\s+|los\s+|una\s+|un\s+)?(?:alarmas?\s+(?:de\s+|para\s+|llamada\s+)?|recordatorio\s+(?:de\s+|para\s+)?)?(.*)$/,
  );

  let query = (afterVerbMatch?.[1] ?? "").trim();

  query = query
    .replace(/^(la|el|las|los|una|un|alarma|alarms|de|para|llamada)\s+/g, "")
    .replace(/\s+(por favor|ya|ahora)$/g, "")
    .trim();

  return { deleteAll: false, query };
}

function findMatchingAlarms(alarms: AlarmItem[], query: string): AlarmItem[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const byLabel = alarms.filter((alarm) => {
    const normLabel = normalizeText(alarm.label);
    if (!normLabel || normLabel === "alarma") return false;
    return (
      normLabel.includes(normalizedQuery) || normalizedQuery.includes(normLabel)
    );
  });

  if (byLabel.length > 0) {
    return byLabel;
  }

  const numMatch = normalizedQuery.match(/\b(\d{1,2})(?::(\d{1,2}))?\b/);
  if (numMatch) {
    const hourNum = parseInt(numMatch[1], 10);
    const minNum = numMatch[2] ? parseInt(numMatch[2], 10) : null;

    const byHour = alarms.filter((alarm) => {
      const targetDate = new Date(alarm.targetDateISO);
      const hour24 = targetDate.getHours();
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const mins = targetDate.getMinutes();

      const hourMatches = hour24 === hourNum || hour12 === hourNum;
      if (!hourMatches) return false;
      if (minNum !== null) {
        return mins === minNum;
      }
      return true;
    });

    if (byHour.length > 0) {
      return byHour;
    }
  }

  return [];
}

function extractInlineCommand(rawText: string): string {
  const clean = normalizeText(rawText);
  const match = clean.match(/\balarmas?\b(.*)$/);
  const tail = match?.[1]?.trim() ?? "";

  if (!tail || /^(por favor|ya|oye|hola)$/.test(tail)) {
    return "";
  }

  if (/^(a las|las|a la|en\s+\d+|para\s+)/.test(tail)) {
    return `alarma ${tail}`;
  }

  return tail;
}

function formatRemainingTime(targetDate: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, targetDate.getTime() - now.getTime());
  const totalMinutes = Math.round(diffMs / 60000);

  if (totalMinutes <= 0) return "menos de un minuto";

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "día" : "días"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
  if (minutes > 0)
    parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);

  return parts.join(", ");
}

function parseAlarmFromSpeech(
  rawText: string,
  now: Date = new Date(),
): {
  ok: boolean;
  alarm?: Omit<AlarmItem, "notificationId">;
  confirmationMessage: string;
} {
  const baseClean = normalizeText(rawText);
  if (!baseClean) {
    return {
      ok: false,
      confirmationMessage:
        'No alcancé a escuchar una hora clara. Di "alarma" y luego dime a qué hora quieres programarla.',
    };
  }

  const clean = replaceSpanishNumberWords(baseClean);

  let target = new Date(now.getTime());
  let matchedTime = false;

  const relMinutesMatch = clean.match(/\b(?:en\s+)?(\d+)\s*minutos?\b/);
  const relHoursMatch = clean.match(/\b(?:en\s+)?(\d+)\s*horas?\b/);

  if (relMinutesMatch && relHoursMatch) {
    const hrs = parseInt(relHoursMatch[1], 10);
    const mins = parseInt(relMinutesMatch[1], 10);
    const totalMins = hrs * 60 + mins;
    if (totalMins > 0) {
      target = new Date(now.getTime() + totalMins * 60000);
      matchedTime = true;
    }
  } else if (relMinutesMatch) {
    const mins = parseInt(relMinutesMatch[1], 10);
    if (mins > 0) {
      target = new Date(now.getTime() + mins * 60000);
      matchedTime = true;
    }
  } else if (relHoursMatch) {
    const hrs = parseInt(relHoursMatch[1], 10);
    if (hrs > 0) {
      target = new Date(now.getTime() + hrs * 3600000);
      matchedTime = true;
    }
  }

  if (!matchedTime) {
    const timeMatch = clean.match(
      /(?:a las|las|a la)?\s*(\d{1,2})(?::(\d{1,2})|\s+y\s+media|\s+y\s+cuarto)?/,
    );

    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      let minute = 0;

      if (timeMatch[2]) {
        minute = parseInt(timeMatch[2], 10);
      } else if (clean.includes("y media")) {
        minute = 30;
      } else if (clean.includes("y cuarto")) {
        minute = 15;
      }

      const hasPM = /\b(tarde|noche|pm|p m)\b/.test(clean);
      const hasAM = /\b(manana|madrugada|am|a m)\b/.test(clean);

      if (hour <= 12) {
        if (hasPM && hour < 12) hour += 12;
        if (hasAM && hour === 12) hour = 0;
        if (!hasPM && !hasAM) {
          const candidateToday = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            hour,
            minute,
            0,
            0,
          );
          if (
            candidateToday <= now &&
            hour >= 1 &&
            hour <= 11 &&
            candidateToday.getTime() + 12 * 3600000 > now.getTime()
          ) {
            hour += 12;
          }
        }
      }

      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        target = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hour,
          minute,
          0,
          0,
        );
        matchedTime = true;
      }
    }
  }

  if (!matchedTime) {
    return {
      ok: false,
      confirmationMessage: `Escuché "${rawText}", pero no identifiqué una hora. Intenta decir algo como "en 3 minutos" o "a las 7 de la noche para estudiar".`,
    };
  }

  let isTomorrow = false;
  if (target <= now) {
    target.setDate(target.getDate() + 1);
    isTomorrow = true;
  }

  const labelMatch = baseClean.match(
    /\bpara\s+([a-z0-9\s]+?)(?:\s+(?:a las|hoy|manana|en\s+\d+)|$)/,
  );
  const rawLabel = labelMatch?.[1]?.trim() ?? "";
  const label =
    rawLabel && !/^(hoy|manana|la tarde|la noche|la manana)$/.test(rawLabel)
      ? rawLabel
      : "Alarma";

  const timeLabel = target.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const remaining = formatRemainingTime(target, now);
  const dayText = isTomorrow ? "para mañana" : "para hoy";

  const alarm: Omit<AlarmItem, "notificationId"> = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timeLabel,
    targetDateISO: target.toISOString(),
    label,
    isTomorrow,
    triggered: false,
  };

  const confirmationMessage = `Listo. Creé la alarma "${label}" a las ${timeLabel} ${dayText} y faltan ${remaining} para que suene.`;

  return {
    ok: true,
    alarm,
    confirmationMessage,
  };
}

interface AlarmRingModalProps {
  alarm: AlarmItem;
  volumePercent: number;
  onDismiss: () => void;
}

function AlarmRingModal({
  alarm,
  volumePercent,
  onDismiss,
}: AlarmRingModalProps) {
  const slideX = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isDismissedRef = useRef(false);

  useEffect(() => {
    isDismissedRef.current = false;
    slideX.setValue(0);

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.04,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.start();

    return () => {
      pulseLoop.stop();
    };
  }, [alarm.id, pulseAnim, slideX]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_evt, gestureState) => {
          if (isDismissedRef.current) return;
          const clamped = Math.max(
            0,
            Math.min(SLIDER_MAX_TRAVEL, gestureState.dx),
          );
          slideX.setValue(clamped);
        },
        onPanResponderRelease: (_evt, gestureState) => {
          if (isDismissedRef.current) return;
          const clamped = Math.max(
            0,
            Math.min(SLIDER_MAX_TRAVEL, gestureState.dx),
          );

          if (clamped >= SLIDER_MAX_TRAVEL * 0.78) {
            isDismissedRef.current = true;
            Animated.timing(slideX, {
              toValue: SLIDER_MAX_TRAVEL,
              duration: 140,
              useNativeDriver: true,
            }).start(() => {
              onDismiss();
            });
          } else {
            Animated.spring(slideX, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 6,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          if (isDismissedRef.current) return;
          Animated.spring(slideX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
      }),
    [onDismiss, slideX],
  );

  const labelOpacity = slideX.interpolate({
    inputRange: [0, SLIDER_MAX_TRAVEL * 0.55],
    outputRange: [1, 0.15],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.ringBackdrop}>
      <View style={styles.blurOrbTop} />
      <View style={styles.blurOrbBottom} />
      <View style={styles.frostedGlassLayer} />

      <View style={styles.ringContent}>
        <View style={styles.ringBadge}>
          <Text style={styles.ringBadgeText}>
            Alarma activa · Volumen {volumePercent}%
          </Text>
        </View>

        <Animated.View
          style={[styles.ringHeaderCard, { transform: [{ scale: pulseAnim }] }]}
        >
          <Text style={styles.ringAlarmTitle} numberOfLines={2}>
            {alarm.label}
          </Text>
          <Text style={styles.ringAlarmTime}>{alarm.timeLabel}</Text>
          <Text style={styles.ringAlarmSub}>
            {alarm.isTomorrow ? "Mañana" : "Hoy"} · Sonido progresivo
          </Text>
        </Animated.View>

        <View style={styles.sliderSection}>
          <View style={styles.sliderTrack}>
            <Animated.Text
              style={[styles.sliderLabel, { opacity: labelOpacity }]}
            >
              Apagar alarma →
            </Animated.Text>

            <Animated.View
              {...panResponder.panHandlers}
              style={[
                styles.sliderThumb,
                {
                  transform: [{ translateX: slideX }],
                },
              ]}
            >
              <Text style={styles.sliderThumbIcon}>→</Text>
            </Animated.View>
          </View>
          <Text style={styles.sliderHint}>
            Desliza hasta el final para detener el sonido
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function IndexScreen() {
  const [userName, setUserName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const [micActive, setMicActive] = useState(false);
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [showSplash, setShowSplash] = useState(true);
  const [ringingAlarm, setRingingAlarm] = useState<AlarmItem | null>(null);
  const [volumePercent, setVolumePercent] = useState(20);

  const splashOpacity = useRef(new Animated.Value(1)).current;
  const splashTranslateY = useRef(new Animated.Value(14)).current;
  const splashScale = useRef(new Animated.Value(0.95)).current;

  const phaseRef = useRef<AssistantPhase>("idle");
  const savedNameRef = useRef<string>("");
  const alarmsRef = useRef<AlarmItem[]>([]);
  const ringingAlarmRef = useRef<AlarmItem | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlockStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const progressiveLoopRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const isMountedRef = useRef<boolean>(true);
  const isStartingRef = useRef<boolean>(false);
  const lastCommandTranscriptRef = useRef<string>("");
  const wakeTriggeredRef = useRef<boolean>(false);
  const commandRetryCountRef = useRef<number>(0);

  useEffect(() => {
    ringingAlarmRef.current = ringingAlarm;
  }, [ringingAlarm]);

  useEffect(() => {
    splashOpacity.setValue(1);
    splashTranslateY.setValue(14);
    splashScale.setValue(0.95);
    setShowSplash(true);

    Animated.parallel([
      Animated.timing(splashTranslateY, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(splashScale, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();

    const hideTimer = setTimeout(() => {
      Animated.timing(splashOpacity, {
        toValue: 0,
        duration: 450,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && isMountedRef.current) {
          setShowSplash(false);
        }
      });
    }, 1500);

    return () => clearTimeout(hideTimer);
  }, [splashOpacity, splashScale, splashTranslateY]);

  const setPhaseSync = useCallback((nextPhase: AssistantPhase) => {
    phaseRef.current = nextPhase;
    if (isMountedRef.current) {
      setPhase(nextPhase);
    }
  }, []);

  useEffect(() => {
    savedNameRef.current = savedName;
  }, [savedName]);

  useEffect(() => {
    alarmsRef.current = alarms;
  }, [alarms]);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopListeningSafely = useCallback(() => {
    clearRestartTimer();
    if (unlockStartTimerRef.current) {
      clearTimeout(unlockStartTimerRef.current);
      unlockStartTimerRef.current = null;
    }
    isStartingRef.current = false;
    if (isMountedRef.current) {
      setMicActive(false);
    }
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      // Ignorar si no había sesión activa
    }
  }, [clearRestartTimer]);

  const stopProgressiveAlarmSound = useCallback(() => {
    if (progressiveLoopRef.current) {
      clearInterval(progressiveLoopRef.current);
      progressiveLoopRef.current = null;
    }
    Vibration.cancel();
    Speech.stop();
  }, []);

  const startProgressiveAlarmSound = useCallback(
    (alarm: AlarmItem) => {
      stopProgressiveAlarmSound();
      if (!isMountedRef.current) return;

      let step = 0;
      const volumes = [0.2, 0.4, 0.65, 0.85, 1.0];
      const pitches = [0.95, 1.02, 1.1, 1.18, 1.25];

      const playPulse = () => {
        if (!isMountedRef.current || !ringingAlarmRef.current) return;
        const idx = Math.min(step, volumes.length - 1);
        const vol = volumes[idx];
        const pitch = pitches[idx];
        setVolumePercent(Math.round(vol * 100));

        Vibration.vibrate([0, 420, 220, 420], false);

        Speech.stop();
        Speech.speak(`¡Alarma! ${alarm.label}. ${alarm.timeLabel}.`, {
          language: "es-ES",
          rate: 1.08,
          pitch,
          volume: vol,
        });

        step += 1;
      };

      playPulse();

      progressiveLoopRef.current = setInterval(() => {
        if (!isMountedRef.current || !ringingAlarmRef.current) {
          stopProgressiveAlarmSound();
          return;
        }
        playPulse();
      }, 2800);
    },
    [stopProgressiveAlarmSound],
  );

  const startRecognitionCycle = useCallback(
    async (targetPhase: "waiting_wake_word" | "listening_command") => {
      if (
        !isMountedRef.current ||
        isStartingRef.current ||
        ringingAlarmRef.current
      ) {
        return;
      }
      clearRestartTimer();
      isStartingRef.current = true;

      try {
        const permission =
          await ExpoSpeechRecognitionModule.getPermissionsAsync();
        const granted = permission.granted
          ? true
          : (await ExpoSpeechRecognitionModule.requestPermissionsAsync())
              .granted;

        if (!granted) {
          isStartingRef.current = false;
          setMicActive(false);
          setPhaseSync("idle");
          return;
        }

        if (targetPhase === "waiting_wake_word") {
          wakeTriggeredRef.current = false;
          commandRetryCountRef.current = 0;
        } else {
          lastCommandTranscriptRef.current = "";
        }

        setPhaseSync(targetPhase);

        ExpoSpeechRecognitionModule.start({
          lang: "es-ES",
          interimResults: true,
          maxAlternatives: 1,
        });
      } catch (err) {
        console.warn("[IAlarm Voice] Error iniciando reconocimiento:", err);
        setMicActive(false);
        setPhaseSync("idle");
      } finally {
        unlockStartTimerRef.current = setTimeout(() => {
          isStartingRef.current = false;
        }, 600);
      }
    },
    [clearRestartTimer, setPhaseSync],
  );

  const speakAndThenListenWakeWord = useCallback(
    (message: string, delayMs = 900) => {
      if (!isMountedRef.current || ringingAlarmRef.current) return;
      stopListeningSafely();

      Speech.stop();
      Speech.speak(message, {
        language: "es-ES",
        rate: 1.0,
        pitch: 1.0,
        onDone: () => {
          if (!isMountedRef.current || ringingAlarmRef.current) return;
          restartTimerRef.current = setTimeout(() => {
            if (
              isMountedRef.current &&
              !ringingAlarmRef.current &&
              phaseRef.current === "processing"
            ) {
              void startRecognitionCycle("waiting_wake_word");
            }
          }, delayMs);
        },
        onError: () => {
          if (!isMountedRef.current || ringingAlarmRef.current) return;
          restartTimerRef.current = setTimeout(() => {
            if (
              isMountedRef.current &&
              !ringingAlarmRef.current &&
              phaseRef.current === "processing"
            ) {
              void startRecognitionCycle("waiting_wake_word");
            }
          }, delayMs);
        },
      });
    },
    [startRecognitionCycle, stopListeningSafely],
  );

  const triggerRingingScreen = useCallback(
    (alarm: AlarmItem) => {
      if (!isMountedRef.current) return;
      stopListeningSafely();
      ringingAlarmRef.current = alarm;
      setRingingAlarm(alarm);
      setVolumePercent(20);
      setPhaseSync("idle");
      startProgressiveAlarmSound(alarm);
    },
    [setPhaseSync, startProgressiveAlarmSound, stopListeningSafely],
  );

  const handleDismissRingingAlarm = useCallback(async () => {
    const activeAlarm = ringingAlarmRef.current;
    ringingAlarmRef.current = null;
    stopProgressiveAlarmSound();
    if (isMountedRef.current) {
      setRingingAlarm(null);
    }

    if (activeAlarm?.notificationId) {
      await cancelAlarmNotification(activeAlarm.notificationId);
    }

    if (isMountedRef.current) {
      restartTimerRef.current = setTimeout(() => {
        if (
          isMountedRef.current &&
          !ringingAlarmRef.current &&
          phaseRef.current === "idle"
        ) {
          void startRecognitionCycle("waiting_wake_word");
        }
      }, 500);
    }
  }, [startRecognitionCycle, stopProgressiveAlarmSound]);

  const deactivateAssistantByVoice = useCallback(
    (_heardText: string) => {
      commandRetryCountRef.current = 0;
      stopListeningSafely();
      setPhaseSync("processing");

      const who = savedNameRef.current ? `, ${savedNameRef.current}` : "";
      const msg = `Entendido${who}, cierro la orden. Sigo atento si dices alarma.`;

      speakAndThenListenWakeWord(msg, 1200);
    },
    [setPhaseSync, speakAndThenListenWakeWord, stopListeningSafely],
  );

  const handleDeleteAlarmByVoice = useCallback(
    async (commandText: string) => {
      const cleaned = commandText.trim();
      commandRetryCountRef.current = 0;
      setPhaseSync("processing");

      const greeting = savedNameRef.current ? `${savedNameRef.current}, ` : "";
      const currentAlarms = alarmsRef.current;

      if (currentAlarms.length === 0) {
        const emptyMsg = `${greeting}no tienes alarmas guardadas para eliminar.`;
        speakAndThenListenWakeWord(emptyMsg);
        return;
      }

      const { deleteAll, query } = extractDeleteTarget(cleaned);

      if (deleteAll) {
        const count = currentAlarms.length;
        await Promise.all(
          currentAlarms.map((item) =>
            cancelAlarmNotification(item.notificationId),
          ),
        );
        alarmsRef.current = [];
        if (isMountedRef.current) setAlarms([]);
        await AsyncStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify([]));

        const allMsg = `${greeting}listo, eliminé todas tus alarmas (${count} en total) y cancelé sus notificaciones.`;
        speakAndThenListenWakeWord(allMsg);
        return;
      }

      const matches = findMatchingAlarms(currentAlarms, query);

      if (matches.length === 0) {
        const availableLabels = currentAlarms
          .map((item) => `"${item.label}" a las ${item.timeLabel}`)
          .join(", ");
        const notFoundMsg = query
          ? `${greeting}no encontré ninguna alarma que coincida con "${query}". Tienes guardadas: ${availableLabels}.`
          : `${greeting}dime el nombre o la hora de la alarma que quieres eliminar. Tienes guardadas: ${availableLabels}.`;

        speakAndThenListenWakeWord(notFoundMsg);
        return;
      }

      await Promise.all(
        matches.map((m) => cancelAlarmNotification(m.notificationId)),
      );

      const idsToRemove = new Set(matches.map((m) => m.id));
      const remainingAlarms = currentAlarms.filter(
        (item) => !idsToRemove.has(item.id),
      );
      alarmsRef.current = remainingAlarms;
      if (isMountedRef.current) setAlarms(remainingAlarms);
      await AsyncStorage.setItem(
        ALARMS_STORAGE_KEY,
        JSON.stringify(remainingAlarms),
      );

      const deletedSummary = matches
        .map((m) => `"${m.label}" de las ${m.timeLabel}`)
        .join(" y ");

      const successMsg = `${greeting}listo, procesé tu instrucción y eliminé la alarma ${deletedSummary}.`;
      speakAndThenListenWakeWord(successMsg);
    },
    [setPhaseSync, speakAndThenListenWakeWord],
  );

  const handleSaveAlarmCommand = useCallback(
    async (commandText: string) => {
      const cleaned = commandText.trim();
      commandRetryCountRef.current = 0;
      setPhaseSync("processing");

      if (!cleaned) {
        const msg =
          'No escuché la hora o el recordatorio. Di "alarma" para intentarlo de nuevo.';
        speakAndThenListenWakeWord(msg);
        return;
      }

      if (containsDeleteCommand(cleaned)) {
        await handleDeleteAlarmByVoice(cleaned);
        return;
      }

      const parsed = parseAlarmFromSpeech(cleaned);
      const greeting = savedNameRef.current ? `${savedNameRef.current}, ` : "";
      const reply = `${greeting}${parsed.confirmationMessage}`;

      if (parsed.ok && parsed.alarm) {
        const notificationId = await scheduleAlarmNotification(parsed.alarm);
        const createdAlarm: AlarmItem = { ...parsed.alarm, notificationId };
        const updated = [createdAlarm, ...alarmsRef.current];
        alarmsRef.current = updated;
        if (isMountedRef.current) {
          setAlarms(updated);
        }
        await AsyncStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(updated));
      }

      speakAndThenListenWakeWord(reply);
    },
    [handleDeleteAlarmByVoice, setPhaseSync, speakAndThenListenWakeWord],
  );

  const triggerWakeAcknowledgment = useCallback(
    (inlineCommand?: string) => {
      if (wakeTriggeredRef.current || ringingAlarmRef.current) return;
      wakeTriggeredRef.current = true;
      commandRetryCountRef.current = 0;
      stopListeningSafely();

      Vibration.vibrate(120);
      setPhaseSync("waking_up");

      const who = savedNameRef.current
        ? `Hola ${savedNameRef.current}`
        : "Hola";
      const promptMsg = `Activado. ${who}, ¿para qué me necesitas?`;

      if (inlineCommand && inlineCommand.length > 2) {
        void handleSaveAlarmCommand(inlineCommand);
        return;
      }

      Speech.stop();
      Speech.speak(promptMsg, {
        language: "es-ES",
        rate: 1.0,
        pitch: 1.05,
        onDone: () => {
          if (!isMountedRef.current || ringingAlarmRef.current) return;
          restartTimerRef.current = setTimeout(() => {
            if (
              isMountedRef.current &&
              !ringingAlarmRef.current &&
              phaseRef.current === "waking_up"
            ) {
              void startRecognitionCycle("listening_command");
            }
          }, 350);
        },
        onError: () => {
          if (!isMountedRef.current || ringingAlarmRef.current) return;
          restartTimerRef.current = setTimeout(() => {
            if (
              isMountedRef.current &&
              !ringingAlarmRef.current &&
              phaseRef.current === "waking_up"
            ) {
              void startRecognitionCycle("listening_command");
            }
          }, 350);
        },
      });
    },
    [
      handleSaveAlarmCommand,
      setPhaseSync,
      startRecognitionCycle,
      stopListeningSafely,
    ],
  );

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!isMountedRef.current || ringingAlarmRef.current) return;
      const nowMs = Date.now();
      const dueAlarms = alarmsRef.current.filter(
        (item) =>
          !item.triggered && new Date(item.targetDateISO).getTime() <= nowMs,
      );

      if (dueAlarms.length === 0) return;

      const primaryAlarm = { ...dueAlarms[0], triggered: true };
      const dueIds = new Set(dueAlarms.map((a) => a.id));
      const updated = alarmsRef.current.map((item) =>
        dueIds.has(item.id) ? { ...item, triggered: true } : item,
      );
      alarmsRef.current = updated;
      if (isMountedRef.current) {
        setAlarms(updated);
      }
      await AsyncStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(updated));

      triggerRingingScreen(primaryAlarm);
    }, 2000);

    return () => clearInterval(interval);
  }, [triggerRingingScreen]);

  useEffect(() => {
    isMountedRef.current = true;

    const notifResponseSub =
      Notifications.addNotificationResponseReceivedListener((response) => {
        if (!isMountedRef.current) return;
        const alarmId = response.notification.request.content.data?.alarmId;
        if (typeof alarmId === "string") {
          const found = alarmsRef.current.find((a) => a.id === alarmId);
          if (found) {
            triggerRingingScreen({ ...found, triggered: true });
          }
        }
      });

    (async () => {
      try {
        await configureAlarmNotifications();
        const [rawAlarms, rawName] = await Promise.all([
          AsyncStorage.getItem(ALARMS_STORAGE_KEY),
          AsyncStorage.getItem(USER_NAME_STORAGE_KEY),
        ]);
        if (!isMountedRef.current) return;
        if (rawAlarms) {
          const parsedAlarms: AlarmItem[] = JSON.parse(rawAlarms);
          alarmsRef.current = parsedAlarms;
          setAlarms(parsedAlarms);
        }
        if (rawName) {
          savedNameRef.current = rawName;
          setSavedName(rawName);
          setUserName(rawName);
        }
      } catch (err) {
        console.warn("[IAlarm Voice] Error cargando datos iniciales:", err);
      } finally {
        if (isMountedRef.current && !ringingAlarmRef.current) {
          restartTimerRef.current = setTimeout(() => {
            if (
              isMountedRef.current &&
              !ringingAlarmRef.current &&
              phaseRef.current === "idle"
            ) {
              void startRecognitionCycle("waiting_wake_word");
            }
          }, 900);
        }
      }
    })();

    return () => {
      isMountedRef.current = false;
      notifResponseSub.remove();
      stopListeningSafely();
      stopProgressiveAlarmSound();
    };
  }, [
    startRecognitionCycle,
    stopListeningSafely,
    stopProgressiveAlarmSound,
    triggerRingingScreen,
  ]);

  useSpeechRecognitionEvent("start", () => {
    if (isMountedRef.current && !ringingAlarmRef.current) {
      setMicActive(true);
    }
  });

  useSpeechRecognitionEvent("result", (event) => {
    if (ringingAlarmRef.current) return;
    const transcript = event.results?.[0]?.transcript?.trim() ?? "";
    if (!transcript) return;

    const currentPhase = phaseRef.current;

    if (currentPhase === "waiting_wake_word") {
      if (containsWakeWord(transcript)) {
        const inlineCmd = extractInlineCommand(transcript);
        triggerWakeAcknowledgment(inlineCmd);
      }
      return;
    }

    if (currentPhase === "listening_command") {
      if (containsDeactivateCommand(transcript)) {
        deactivateAssistantByVoice(transcript);
        return;
      }
      lastCommandTranscriptRef.current = transcript;
      if (event.isFinal) {
        void handleSaveAlarmCommand(transcript);
      }
    }
  });

  useSpeechRecognitionEvent("end", () => {
    if (!isMountedRef.current) return;
    setMicActive(false);
    if (ringingAlarmRef.current) return;

    const currentPhase = phaseRef.current;

    if (currentPhase === "waiting_wake_word") {
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        if (
          isMountedRef.current &&
          !ringingAlarmRef.current &&
          phaseRef.current === "waiting_wake_word"
        ) {
          void startRecognitionCycle("waiting_wake_word");
        }
      }, 650);
    } else if (currentPhase === "listening_command") {
      const captured = lastCommandTranscriptRef.current.trim();
      if (captured) {
        void handleSaveAlarmCommand(captured);
      } else if (commandRetryCountRef.current < 1) {
        commandRetryCountRef.current += 1;
        clearRestartTimer();
        restartTimerRef.current = setTimeout(() => {
          if (
            isMountedRef.current &&
            !ringingAlarmRef.current &&
            phaseRef.current === "listening_command"
          ) {
            void startRecognitionCycle("listening_command");
          }
        }, 350);
      } else {
        commandRetryCountRef.current = 0;
        setPhaseSync("processing");
        const fallbackMsg =
          "No te escuché decir la hora o el comando. Sigo atento si dices alarma.";
        speakAndThenListenWakeWord(fallbackMsg, 900);
      }
    }
  });

  useSpeechRecognitionEvent("error", () => {
    if (!isMountedRef.current) return;
    setMicActive(false);
    if (ringingAlarmRef.current) return;

    const currentPhase = phaseRef.current;

    if (currentPhase === "waiting_wake_word") {
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        if (
          isMountedRef.current &&
          !ringingAlarmRef.current &&
          phaseRef.current === "waiting_wake_word"
        ) {
          void startRecognitionCycle("waiting_wake_word");
        }
      }, 1200);
      return;
    }

    if (currentPhase === "listening_command") {
      const captured = lastCommandTranscriptRef.current.trim();
      if (captured) {
        void handleSaveAlarmCommand(captured);
        return;
      }
      if (commandRetryCountRef.current < 1) {
        commandRetryCountRef.current += 1;
        clearRestartTimer();
        restartTimerRef.current = setTimeout(() => {
          if (
            isMountedRef.current &&
            !ringingAlarmRef.current &&
            phaseRef.current === "listening_command"
          ) {
            void startRecognitionCycle("listening_command");
          }
        }, 600);
        return;
      }
      commandRetryCountRef.current = 0;
      setPhaseSync("processing");
      const errMsg =
        "No pude capturar el comando. Sigo atento si dices alarma.";
      speakAndThenListenWakeWord(errMsg, 1000);
    }
  });

  const handleToggleWakeMode = () => {
    if (ringingAlarmRef.current) return;
    if (phase === "idle") {
      void startRecognitionCycle("waiting_wake_word");
    } else {
      stopListeningSafely();
      Speech.stop();
      setPhaseSync("idle");
    }
  };

  const handleSaveName = async () => {
    const trimmed = userName.trim();
    savedNameRef.current = trimmed;
    setSavedName(trimmed);
    await AsyncStorage.setItem(USER_NAME_STORAGE_KEY, trimmed);
  };

  const handleDeleteAlarm = async (id: string) => {
    const targetAlarm = alarmsRef.current.find((item) => item.id === id);
    await cancelAlarmNotification(targetAlarm?.notificationId);

    const updated = alarmsRef.current.filter((item) => item.id !== id);
    alarmsRef.current = updated;
    setAlarms(updated);
    await AsyncStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(updated));
  };

  const getStatusBannerText = () => {
    const micIcon = micActive ? "🎤" : "🔇";
    switch (phase) {
      case "waiting_wake_word":
        return micActive
          ? '🎤 Listo — di "alarma"'
          : "🔇 Reanudando escucha...";
      case "waking_up":
        return "🔔 Escuchando...";
      case "listening_command":
        return `${micIcon} Di tu alarma o "desactívate"`;
      case "processing":
        return "⚙️ Procesando...";
      default:
        return "🔇 Pausado — toca para activar";
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerBlock}>
          <Text style={styles.brandTag}>IAlarm</Text>
          <Text style={styles.title}>
            {savedName ? `Hola, ${savedName}` : "Tus alarmas"}
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.statusBadge,
            phase === "waking_up" && styles.statusBadgeWake,
            phase === "listening_command" && styles.statusBadgeListening,
          ]}
          onPress={handleToggleWakeMode}
          activeOpacity={0.8}
        >
          <Text style={styles.statusText}>{getStatusBannerText()}</Text>
        </TouchableOpacity>

        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="Tu nombre"
            placeholderTextColor="#64748B"
            value={userName}
            onChangeText={setUserName}
          />
          <TouchableOpacity
            style={styles.smallBtn}
            onPress={handleSaveName}
            activeOpacity={0.85}
          >
            <Text style={styles.btnText}>Guardar</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>Alarmas ({alarms.length})</Text>

        {alarms.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No hay alarmas programadas.</Text>
          </View>
        ) : (
          alarms.map((alarm) => (
            <View key={alarm.id} style={styles.alarmCard}>
              <View style={styles.alarmInfo}>
                <Text style={styles.alarmTime}>{alarm.timeLabel}</Text>
                <Text style={styles.alarmMeta}>
                  {alarm.label} · {alarm.isTomorrow ? "Mañana" : "Hoy"}
                  {alarm.triggered ? " · Sonó" : ""}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleDeleteAlarm(alarm.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.deleteText}>Eliminar</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>

      {ringingAlarm ? (
        <AlarmRingModal
          alarm={ringingAlarm}
          volumePercent={volumePercent}
          onDismiss={() => void handleDismissRingingAlarm()}
        />
      ) : null}

      {showSplash ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.splashOverlay,
            {
              opacity: splashOpacity,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.splashCard,
              {
                transform: [
                  { translateY: splashTranslateY },
                  { scale: splashScale },
                ],
              },
            ]}
          >
            <Text style={styles.splashTitle}>IAlarm</Text>
          </Animated.View>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F0F9FF",
  },
  content: {
    padding: 20,
    gap: 14,
  },
  headerBlock: {
    gap: 2,
    marginTop: 4,
  },
  brandTag: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0284C7",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0F172A",
  },
  statusBadge: {
    backgroundColor: "#FFFFFF",
    borderColor: "#BAE6FD",
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  statusBadgeWake: {
    backgroundColor: "#E0F2FE",
    borderColor: "#38BDF8",
  },
  statusBadgeListening: {
    backgroundColor: "#D6EEFF",
    borderColor: "#0284C7",
  },
  statusText: {
    color: "#0F172A",
    fontWeight: "600",
    fontSize: 14,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderColor: "#BAE6FD",
    borderWidth: 1,
    color: "#0F172A",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
  },
  smallBtn: {
    backgroundColor: "#0284C7",
    borderRadius: 12,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  btnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 15,
  },
  sectionTitle: {
    color: "#1E293B",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 6,
  },
  emptyCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E0F2FE",
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
  },
  emptyText: {
    color: "#64748B",
    fontSize: 14,
  },
  alarmCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#BAE6FD",
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  alarmInfo: {
    gap: 2,
  },
  alarmTime: {
    color: "#0F172A",
    fontSize: 19,
    fontWeight: "700",
  },
  alarmMeta: {
    color: "#475569",
    fontSize: 13,
  },
  deleteText: {
    color: "#0369A1",
    fontWeight: "600",
    fontSize: 14,
  },
  splashOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#E0F2FE",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 30,
  },
  splashCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#7DD3FC",
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 22,
    paddingHorizontal: 38,
  },
  splashTitle: {
    fontSize: 32,
    fontWeight: "800",
    color: "#0284C7",
    letterSpacing: 0.5,
  },
  ringBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 25,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  frostedGlassLayer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(224, 242, 254, 0.92)",
  },
  blurOrbTop: {
    position: "absolute",
    top: -80,
    left: -60,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: "rgba(125, 211, 252, 0.45)",
  },
  blurOrbBottom: {
    position: "absolute",
    bottom: -90,
    right: -60,
    width: 310,
    height: 310,
    borderRadius: 155,
    backgroundColor: "rgba(186, 230, 253, 0.58)",
  },
  ringContent: {
    width: "100%",
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 48,
    flex: 1,
  },
  ringBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.88)",
    borderColor: "#7DD3FC",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  ringBadgeText: {
    color: "#0369A1",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  ringHeaderCard: {
    width: "100%",
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    borderColor: "#BAE6FD",
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
  },
  ringAlarmTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#0F172A",
    textAlign: "center",
  },
  ringAlarmTime: {
    fontSize: 44,
    fontWeight: "800",
    color: "#0284C7",
    letterSpacing: 0.5,
  },
  ringAlarmSub: {
    fontSize: 14,
    fontWeight: "600",
    color: "#475569",
  },
  sliderSection: {
    width: "100%",
    alignItems: "center",
    gap: 10,
  },
  sliderTrack: {
    width: SLIDER_TRACK_WIDTH,
    height: SLIDER_THUMB_SIZE + SLIDER_PADDING * 2,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.92)",
    borderColor: "#7DD3FC",
    borderWidth: 1.5,
    padding: SLIDER_PADDING,
    justifyContent: "center",
    position: "relative",
  },
  sliderLabel: {
    position: "absolute",
    alignSelf: "center",
    color: "#0369A1",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  sliderThumb: {
    width: SLIDER_THUMB_SIZE,
    height: SLIDER_THUMB_SIZE,
    borderRadius: 999,
    backgroundColor: "#0284C7",
    justifyContent: "center",
    alignItems: "center",
  },
  sliderThumbIcon: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "800",
  },
  sliderHint: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "500",
  },
});
