export const RECOVERY_REASONS = {
  "guard_1": "AI 오류 응답은 채팅에 복구하지 않습니다.",
  "guard_2": "도구 호출이 포함된 응답은 자동 복구하지 않습니다.",
  "guard_3": "복구할 텍스트 답장을 찾지 못했습니다.",
  "guard_4": "복구 대기 요청이 너무 많습니다. 기존 요청을 먼저 확인해 주세요.",
  "guard_5": "서버 플러그인도 0.1.0-test.3 이상으로 업데이트하고 서버를 재시작해 주세요.",
  "guard_6": "채팅 저장 상태를 확인하지 못했습니다.",
  "guard_7": "원래 채팅 파일을 확인하지 못했습니다.",
  "guard_8": "브라우저에 복구 정보를 기록하지 못했습니다.",
  "guard_9": "복구 응답 위치가 일치하지 않습니다.",
  "guard_10": "복구 응답 크기가 올바르지 않습니다.",
  "guard_11": "복구 도중 서버의 채팅 내용이 바뀌어 저장을 멈췄어요. 다른 기기의 답장을 덮어쓰지 않았어요. 원래 채팅을 다시 열어 확인해 주세요.",
  "guard_12": "답장 정리 후 복구할 본문이 없습니다.",
  "guard_13": "복구 준비 중 서버의 채팅 내용이 바뀌어 자동 복구를 멈췄어요. 원래 채팅을 다시 열어 확인해 주세요.",
  "guard_14": "서버의 채팅 내용이 바뀌어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.",
  "guard_15": "채팅에 새 메시지나 수정이 있어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.",
  "guard_16": "서버와 현재 페이지의 이전 메시지 기록이 달라 저장을 멈췄어요. 원래 채팅을 다시 열어 확인해 주세요.",
  "guard_17": "복구한 답장의 저장 내용이 화면과 일치하는지 확인하지 못했어요. 응답을 유지하고 다시 확인합니다.",
  "guard_18": "답장을 기다리던 1:1 채팅을 먼저 열어 주세요.",
  "guard_19": "이 채팅의 이전 대기 요청이 여러 개라 자동으로 고르지 않았어요.",
  "guard_20": "원래 채팅과 현재 내용이 달라 복구를 멈췄어요. 기존 메시지는 변경하지 않았어요.",
  "guard_21": "서버에서 아직 답장을 받고 있어요. 완료된 뒤 다시 눌러 주세요.",
  "guard_22": "서버에 복구할 완료 답장이 없어요.",
  "guard_23": "저장 완료 표시는 있지만 현재 화면의 내용이 달라 복구 확인을 보류했어요. 수동 수정이 사라지지 않도록 덮어쓰지 않았어요. 내용을 확인한 뒤 원래 채팅을 다시 열어 주세요.",
  "guard_24": "답장은 채팅 파일에 저장돼 있지만 현재 화면의 내용이 달라 자동으로 바꾸지 않았어요. 원래 채팅을 다시 열어 주세요.",
  "guard_25": "답장은 복구했지만 후처리 확장에서 오류가 났습니다."
};
export function recoveryReason(error) {
    const known = Object.entries(RECOVERY_REASONS).find(([, message]) => message === error?.message);
    if (known) return known[0];
    if (error?.candidateFailed) return 'candidate_failed';
    if (error?.candidateRejected) return 'candidate_rejected';
    if (error?.noCompletedReply) return 'no_completed_reply';
    return ({ TimeoutError: 'timeout', AbortError: 'aborted', TypeError: 'network' })[error?.name] || 'unknown';
}
