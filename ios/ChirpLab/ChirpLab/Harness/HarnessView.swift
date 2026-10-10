import ChirpCore
import PushToTalk
import SwiftUI

/// Minimal experiment harness. Owned by JD: this is the interaction surface for
/// Experiment E and the user-visible listening states. It talks to LabModel only
/// through its published state and the press/release/toggle/join/leave methods.
struct HarnessView: View {
    @ObservedObject var model: LabModel
    @State private var holding = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Group {
                    TextField("Server URL (ws://host:8787)", text: $model.serverURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Test token", text: $model.token)
                    TextField("Conversation", text: $model.conversationId)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Connect") { model.connect() }
                    Button("Disconnect") { model.disconnect() }
                    Button("Join") { model.join() }
                    Button("Leave") { model.leave() }
                }
                .buttonStyle(.bordered)

                HStack {
                    Button("Half") { model.setMode(.halfDuplex) }
                    Button("Full") { model.setMode(.fullDuplex) }
                    Button("Toggle (intent)") { model.toggle(.intent) }
                }
                .buttonStyle(.bordered)

                status

                Text(holding ? "TALKING" : "HOLD TO TALK")
                    .font(.title2.bold())
                    .frame(maxWidth: .infinity, minHeight: 120)
                    .background(holding ? Color.red : Color.blue, in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(.white)
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in
                                if !holding { holding = true; model.press() }
                            }
                            .onEnded { _ in
                                holding = false
                                model.release()
                            }
                    )

                if !model.notice.isEmpty { Text(model.notice).foregroundStyle(.orange) }

                Button("Clear log") { model.clearLog() }.buttonStyle(.bordered)
                Text("Events are saved to lab-events.jsonl (Files app > On My iPhone > Chirp Lab).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding()
        }
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("PTT manager: \(model.managerStatus)")
            Text("Joined: \(model.joined ? "yes" : "no")")
            Text("Connection: \(model.connection.rawValue)")
            Text("Transmit phase: \(String(describing: model.phase))")
        }
        .font(.footnote.monospaced())
    }
}
