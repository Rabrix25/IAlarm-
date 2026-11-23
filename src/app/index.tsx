import { useState } from "react";
import {
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

// Definimos cómo luce cada recordatorio
interface Recordatorio {
  id: string;
  titulo: string;
  hora: string;
}

export default function HomeScreen() {
  // Estados para guardar lo que escribes y la lista de recordatorios
  const [titulo, setTitulo] = useState("");
  const [hora, setHora] = useState("");
  const [lista, setLista] = useState<Recordatorio[]>([
    { id: "1", titulo: "Tomar agua", hora: "15:00" },
  ]);

  // Función que se ejecuta al tocar "Agregar"
  const agregarRecordatorio = () => {
    if (!titulo.trim() || !hora.trim()) return;

    const nuevo: Recordatorio = {
      id: Date.now().toString(),
      titulo: titulo.trim(),
      hora: hora.trim(),
    };

    setLista([nuevo, ...lista]);
    setTitulo("");
    setHora("");
  };

  // Función para eliminar un elemento
  const eliminarRecordatorio = (id: string) => {
    setLista(lista.filter((item) => item.id !== id));
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Alarma IA</Text>
      <Text style={styles.subtitle}>Mis alarmas y recordatorios</Text>

      {/* Formulario rápido */}
      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="¿Qué te recuerdo? (Ej: Llamar al médico)"
          placeholderTextColor="#71717a"
          value={titulo}
          onChangeText={setTitulo}
        />
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.horaInput]}
            placeholder="Hora (Ej: 18:30)"
            placeholderTextColor="#71717a"
            value={hora}
            onChangeText={setHora}
          />
          <TouchableOpacity style={styles.button} onPress={agregarRecordatorio}>
            <Text style={styles.buttonText}>+ Agregar</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Lista de recordatorios */}
      <FlatList
        data={lista}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>No tienes recordatorios aún.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View>
              <Text style={styles.cardTime}>{item.hora}</Text>
              <Text style={styles.cardTitle}>{item.titulo}</Text>
            </View>
            <TouchableOpacity onPress={() => eliminarRecordatorio(item.id)}>
              <Text style={styles.deleteText}>Eliminar</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#121212",
    paddingHorizontal: 20,
    paddingTop: 50,
  },
  title: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "bold",
  },
  subtitle: {
    color: "#a1a1aa",
    fontSize: 15,
    marginBottom: 20,
  },
  form: {
    gap: 10,
    marginBottom: 20,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    backgroundColor: "#1e1e22",
    color: "#ffffff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#27272a",
  },
  horaInput: {
    flex: 1,
  },
  button: {
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingHorizontal: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "bold",
    fontSize: 15,
  },
  list: {
    gap: 12,
    paddingBottom: 30,
  },
  card: {
    backgroundColor: "#1e1e22",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#27272a",
  },
  cardTime: {
    color: "#60a5fa",
    fontSize: 18,
    fontWeight: "bold",
  },
  cardTitle: {
    color: "#f4f4f5",
    fontSize: 15,
    marginTop: 2,
  },
  deleteText: {
    color: "#ef4444",
    fontSize: 14,
    fontWeight: "600",
  },
  empty: {
    color: "#71717a",
    textAlign: "center",
    marginTop: 40,
  },
});
