/**
 * ZWIFT COMMANDER - STEERING EDITION
 * Hardware: ESP32 D1 Mini (WROOM)
 * Fix: Lenkung (Links/Rechts) reagiert jetzt sofort (Hold-to-steer)
 */

#include <BleKeyboard.h>

BleKeyboard bleKeyboard("BikeTerra Commander", "DIY", 100);

const int LONG_PRESS_MS = 500; 

class SmartButton {
  private:
    int pin;
    int keyShort;
    int keyLong;
    bool useShiftLong; 
    bool isSteeringKey; // NEU: Ist das eine Lenk-Taste?
    
    unsigned long pressStartTime = 0;
    bool isPressed = false;
    bool longPressTriggered = false; // Damit Longpress nur 1x feuert

  public:
    // Konstruktor erweitert: isSteering (true für Links/Rechts)
    SmartButton(int p, int kS, int kL, bool shiftL, bool steering) {
      pin = p;
      keyShort = kS;
      keyLong = kL;
      useShiftLong = shiftL;
      isSteeringKey = steering;
    }

    void begin() {
      pinMode(pin, INPUT_PULLUP);
    }

    void update() {
      bool active = (digitalRead(pin) == LOW); // LOW = Gedrückt

      // --- TASTE WIRD GERADE GEDRÜCKT ---
      if (active) {
        if (!isPressed) {
          // 1. Moment des Drückens (Flanke)
          isPressed = true;
          pressStartTime = millis();
          longPressTriggered = false;
          
          // WENN ES EINE LENKTASTE IST: SOFORT DRÜCKEN!
          if (isSteeringKey) {
            bleKeyboard.press(keyShort); 
          }
        }

        // 2. Taste wird gehalten (Prüfung auf Longpress)
        if (!longPressTriggered && (millis() - pressStartTime > LONG_PRESS_MS)) {
          // Longpress Zeit erreicht!
          
          if (isSteeringKey) {
            // Bei Lenkung: Erst Lenken beenden, dann Longpress feuern
            bleKeyboard.release(keyShort); 
          }
          
          if (keyLong != 0) {
            Serial.print("Longpress auf Pin "); Serial.println(pin);
            if (useShiftLong) bleKeyboard.press(KEY_LEFT_SHIFT);
            bleKeyboard.write(keyLong);
            if (useShiftLong) bleKeyboard.release(KEY_LEFT_SHIFT);
          }
          
          longPressTriggered = true; // Damit es nicht dauernd feuert
        }
      }
      
      // --- TASTE WURDE LOSGELASSEN ---
      else if (!active && isPressed) {
        isPressed = false;

        // War es nur ein kurzer Druck?
        if (!longPressTriggered) {
          if (isSteeringKey) {
            // Lenkung beenden (Release)
            bleKeyboard.release(keyShort);
          } else {
            // Normale Taste: Jetzt erst feuern (Tap)
            Serial.print("Click auf Pin "); Serial.println(pin);
            bleKeyboard.write(keyShort);
          }
        }
        // Falls Longpress schon gefeuert hat, müssen wir beim Loslassen nichts tun
      }
    }
};

// --- TASTEN DEFINITION ---

// MODUL 1 (Steering Keys: letzter Parameter auf "true"!)
// Links/Rechts: isSteering = true -> Reagiert sofort!
SmartButton m1_Left(16, KEY_LEFT_ARROW, 'r', true, true);    // Links lenken (sofort) / Shift+R (lang)
SmartButton m1_Right(17, KEY_RIGHT_ARROW, 'n', true, true);  // Rechts lenken (sofort) / Shift+N (lang)

// Die anderen bleiben normale "Tap" Tasten (isSteering = false)
SmartButton m1_Up(18, 'w', ' ', true, false);                
SmartButton m1_Down(19, 's', 'e', true, false);          
SmartButton m1_Center(21, 'b', ',', false, false);           

// MODUL 2 (Einfache Tasten)
SmartButton m2_Left(22, 'c', 0, false, false);
SmartButton m2_Right(23, 'p', 0, false, false);
SmartButton m2_Up(25, 'm', 0, false, false);
SmartButton m2_Down(26, 't', 0, false, false);
SmartButton m2_Center(27, 'f', 0, false, false);

void setup() {
  Serial.begin(115200);
  
  // Alle initialisieren
  m1_Left.begin(); m1_Right.begin(); m1_Up.begin(); m1_Down.begin(); m1_Center.begin();
  m2_Left.begin(); m2_Right.begin(); m2_Up.begin(); m2_Down.begin(); m2_Center.begin();

  bleKeyboard.begin();
  Serial.println("Steering Fix Active!");
}

void loop() {
  if (bleKeyboard.isConnected()) {
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
  delay(10);
}
