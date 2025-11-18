#!/bin/zsh
uri="http://127.0.0.1:3100/api/ingest"

for i in {1..30}; do
  # สุ่มค่าระหว่าง 200-500
  v=$(( 200 + RANDOM % 301 ))

  # ถ้า v > 380 ให้ detected = true
  if [ "$v" -gt 380 ]; then
    detected=true
  else
    detected=false
  fi

  body=$(cat <<EOF
{
  "value": $v,
  "threshold": 0.5,
  "detected": $detected,
  "buzzer_on": false,
  "servo_angle": 0
}
EOF
)

  curl -s -X POST "$uri" \
    -H "Content-Type: application/json" \
    -d "$body" > /dev/null

  sleep 0.7
done

