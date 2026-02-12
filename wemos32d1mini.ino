/**
 * ZWIFT / GAMING DUAL NAVI-SWITCH CONTROLLER
 * Hardware: ESP32 D1 Mini (WROOM)
 * Input: 2x 5-Way Navigation Switches (Digital)
 * Features: Short press & Long press detection
 */

#include <BleKeyboard.h>

// Bluetooth Name
BleKeyboard bleKeyboard("Zwift Commander", "DIY", 100);

// Zeit in Millisekunden für "Langer Druck"
const int LONG_PRESS_MS = 500; 

// --- BUTTON KLASSE (Macht den Code sauber) ---
class SmartButton {
  private:
    int pin;
    int keyShort;
    int keyLong;
    bool useShiftShort; // Soll Shift bei Kurz gedrückt werden? (Hier meist false)
    bool useShiftLong;  // Soll Shift bei Lang gedrückt werden?
    
    unsigned long pressStartTime = 0;
    bool isPressed = false;
    bool handled = false; // Damit wir nicht dauernd feuern

  public:
    // Konstruktor: Pin, TasteKurz, TasteLang, ShiftBeiLang?
    SmartButton(int p, int kS, int kL = 0, bool shiftL = false) {
      pin = p;
      keyShort = kS;
      keyLong = kL;
      useShiftShort = false;
      useShiftLong = shiftL;
    }

    void begin() {
      pinMode(pin, INPUT_PULLUP); // WICHTIG: Interner Widerstand an!
    }

    void update() {
      // Lesen (LOW bedeutet gedrückt, wegen Pullup)
      bool active = (digitalRead(pin) == LOW);

      if (active && !isPressed) {
        // Start des Drückens
        isPressed = true;
        pressStartTime = millis();
        handled = false;
      }
      else if (!active && isPressed) {
        // Losgelassen! Jetzt entscheiden: Kurz oder Lang?
        isPressed = false;
        
        if (!handled) {
          unsigned long duration = millis() - pressStartTime;
          
          if (duration >= LONG_PRESS_MS && keyLong != 0) {
            // --- LANGER DRUCK ---
            Serial.print("Lang auf Pin "); Serial.println(pin);
            if (useShiftLong) bleKeyboard.press(KEY_LEFT_SHIFT);
            bleKeyboard.write(keyLong);
            if (useShiftLong) bleKeyboard.release(KEY_LEFT_SHIFT);
          } 
          else {
            // --- KURZER DRUCK ---
            Serial.print("Kurz auf Pin "); Serial.println(pin);
            // Spezialfall: Pfeiltasten und Buchstaben
            bleKeyboard.write(keyShort);
          }
        }
      }
      // Optional: Dauerfeuer verhindern oder Repeats hier einbauen
    }
};

// --- TASTEN DEFINITION ---

// MODUL 1 (Mit Longpress Funktionen)
// Format: SmartButton(PIN, TasteKurz, TasteLang, ShiftBeiLang?)
SmartButton m1_Left(16, KEY_LEFT_ARROW, 'r', true);   // Kurz: Links, Lang: Shift+R
SmartButton m1_Right(17, KEY_RIGHT_ARROW, 'n', true); // Kurz: Rechts, Lang: Shift+N
SmartButton m1_Up(18, 'w', ' ', true);                // Kurz: w, Lang: Shift+Space
SmartButton m1_Down(19, 's', KEY_ESC, true);          // Kurz: s, Lang: Shift+ESC
SmartButton m1_Center(21, 'b', ',', false);           // Kurz: b, Lang: , (Kein Shift)

// MODUL 2 (Nur einfache Funktionen)
// Da kein Longpress gewünscht, lassen wir die hinteren Parameter weg oder auf 0
SmartButton m2_Left(22, 'c');
SmartButton m2_Right(23, 'p');
SmartButton m2_Up(25, 'm');
SmartButton m2_Down(26, 't');
SmartButton m2_Center(27, 'f');


void setup() {
  Serial.begin(115200);
  Serial.println("Starte Dual Commander...");

  // Alle Tasten initialisieren
  m1_Left.begin(); m1_Right.begin(); m1_Up.begin(); m1_Down.begin(); m1_Center.begin();
  m2_Left.begin(); m2_Right.begin(); m2_Up.begin(); m2_Down.begin(); m2_Center.begin();

  bleKeyboard.begin();
}

void loop() {
  if (bleKeyboard.isConnected()) {
    // Alle Tasten abfragen
    m1_Left.update();
    m1_Right.update();
    m1_Up.update();
    m1_Down.update();
    m1_Center.update();
    
    m2_Left.update();
    m2_Right.update();
    m2_Up.update();
    m2_Down.update();
    m2_Center.update();
  }
  
  // Kleines Delay zur Entlastung (Entprellen übernimmt die Logik oben teils mit)
  delay(10);
}