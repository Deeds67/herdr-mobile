import ExpoModulesCore
import Foundation

private struct EngineError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// One thread with a big stack that runs queued jobs in order. A QuickJS runtime
/// must stay on the thread that made it, and a mod must never run on the UI or
/// React Native's JS thread.
private final class EngineThread: Thread {
  private let lock = NSCondition()
  private var jobs: [() -> Void] = []
  private var stopped = false

  override init() {
    super.init()
    name = "mod-engine"
    stackSize = 16 << 20
  }

  func submit(_ job: @escaping () -> Void) {
    lock.lock()
    jobs.append(job)
    lock.signal()
    lock.unlock()
  }

  func stop() {
    lock.lock()
    stopped = true
    lock.signal()
    lock.unlock()
  }

  override func main() {
    while true {
      lock.lock()
      while jobs.isEmpty && !stopped { lock.wait() }
      if jobs.isEmpty && stopped {
        lock.unlock()
        return
      }
      let job = jobs.removeFirst()
      lock.unlock()
      job()
    }
  }
}

public class ModEngineModule: Module {
  private let thread: EngineThread = {
    let t = EngineThread()
    t.start()
    return t
  }()
  // Only touched on `thread`.
  private var engines: [String: OpaquePointer] = [:]

  private func onThread<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { cont in
      thread.submit {
        do { cont.resume(returning: try work()) } catch { cont.resume(throwing: error) }
      }
    }
  }

  private func handle(_ id: String) throws -> OpaquePointer {
    guard let h = engines[id] else { throw EngineError("no mod engine \(id)") }
    return h
  }

  private func text(_ s: UnsafeMutablePointer<CChar>?) throws -> String {
    guard let s else { throw EngineError("the mod engine ran out of memory") }
    defer { me_free_string(s) }
    return String(cString: s)
  }

  public func definition() -> ModuleDefinition {
    Name("ModEngine")

    AsyncFunction("create") { (id: String, memoryLimit: Double, budgetMs: Int) async throws -> Void in
      try await self.onThread {
        if let old = self.engines.removeValue(forKey: id) { me_free(old) }
        guard let h = me_new(Int(memoryLimit), Int32(budgetMs)) else { throw EngineError("could not create a mod engine") }
        self.engines[id] = h
      }
    }

    AsyncFunction("load") { (id: String, files: String, entry: String) async throws -> String in
      try await self.onThread { try self.text(me_load(try self.handle(id), files, entry)) }
    }

    AsyncFunction("call") { (id: String, name: String, args: String) async throws -> String in
      try await self.onThread { try self.text(me_call(try self.handle(id), name, args)) }
    }

    AsyncFunction("dispose") { (id: String) async throws -> Void in
      try await self.onThread {
        if let old = self.engines.removeValue(forKey: id) { me_free(old) }
      }
    }

    OnDestroy {
      self.thread.submit {
        for h in self.engines.values { me_free(h) }
        self.engines.removeAll()
      }
      self.thread.stop()
    }
  }
}
