> **Bản tiếng Anh được ưu tiên:** Nếu có bất kỳ khác biệt nào, [tệp tiếng Anh](2026-11-05-redeploy-4-prescan.md) là bản có hiệu lực.

# Báo cáo kiểm toán bảo mật Tape Pool

**Date:** 2026-11-11  
**Type:** Kiểm toán bảo mật do đội ngũ Tape Pool thực hiện: rà soát có AI hỗ trợ, AI phân loại bằng chứng và chủ dự án là người đưa ra quyết định. Không độc lập.  
**Release state:** riêng tư. Người đọc độc lập đã cho PASS báo cáo đã sửa ở lần đọc thứ ba (2026-11-11), sau đó có các bản tiếng Việt. Ngày 2026-11-13 các liên kết được trỏ lại vào repo, và các tệp chạy mà chúng dẫn tới được chép vào `runs/`, thư mục nằm ngoài git theo quy tắc 7 của mẫu; ngoài ra nội dung không đổi. Ngày 2026-11-15 M-01 nhận Status và dòng Resolution (mẫu §2 bước 9), và các số đếm tóm tắt cập nhật theo. Chưa được phép công bố.

## Tóm tắt điều hành

Đội ngũ Tape Pool đã xem xét các hợp đồng dự kiến triển khai lại và các cổng kiểm tra triển khai bằng AI đọc mã nguồn, kiểm thử và chủ dự án phân loại. Các phát hiện hợp lệ cuối cùng gồm không Critical, một High, một Medium, chín Low và không Info. Chủ dự án xác nhận chấp nhận mười phát hiện; phát hiện Medium đã được sửa trong `7fce86e` (R4-08). Một nhận định Low trước đây về mốc ngừng cho vay là Invalid đối với mã và không nằm trong mười một phát hiện đó.

| Severity | Count | Fixed | Acknowledged | Open |
|---|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 |
| High | 1 | 0 | 1 | 0 |
| Medium | 1 | 1 | 0 | 0 |
| Low | 9 | 0 | 9 | 0 |
| Info | 0 | 0 | 0 | 0 |
| Below threshold | 0 | 0 | 0 | 0 |

Nhận định Invalid đối với mã: một (Low trước đây), được theo dõi riêng. Phát hiện Fixed: một (M-01, xử lý ngày 2026-11-15).

## Phạm vi

**Audited commit:** `ceed0a2`, bản xuất được cung cấp từ nhánh `redeploy-v4`. Bản xuất không có lịch sử Git của work. Vì vậy không thể kiểm tra độc lập `git diff ceed0a2..HEAD -- src/`. Cả 372 tệp gốc đều khớp hàm băm trước khi phân loại, gồm 32 tệp mã nguồn Solidity; xem [biên bản toàn vẹn sau câu trả lời của chủ dự án](2026-11-05-redeploy-4-prescan/runs/post-owner-integrity.json). Các kiểm thử thêm trong đường dẫn kiểm toán được phép không làm thay đổi mã sản xuất.

**In scope:** 3238 nSLOC trong 28 tệp, được đo nhất quán bằng `report-data.cjs nSLOC v1` trên Node.js v24.22.1. Công cụ đếm các dòng vật lý không trống sau khi loại chú thích theo cú pháp từ vựng, kể cả dấu ngoặc nhọn. Công cụ giữ nguyên chuỗi. [Số đo và định nghĩa](2026-11-05-redeploy-4-prescan/runs/scope-nsloc.json) cùng [mã nguồn đo đếm](2026-11-05-redeploy-4-prescan/runs/report-data.cjs) cho phép tái lập kết quả.

| File | nSLOC |
|---|---:|
| [src/AgentFactory.sol](../../src/AgentFactory.sol) | 47 |
| [src/CreditPolicy.sol](../../src/CreditPolicy.sol) | 239 |
| [src/RigAgent.sol](../../src/RigAgent.sol) | 626 |
| [src/RigScreen.sol](../../src/RigScreen.sol) | 82 |
| [src/TapeLens.sol](../../src/TapeLens.sol) | 152 |
| [src/TapePool.sol](../../src/TapePool.sol) | 715 |
| [src/feed/BscRigReader.sol](../../src/feed/BscRigReader.sol) | 45 |
| [src/feed/FeedLock.sol](../../src/feed/FeedLock.sol) | 17 |
| [src/feed/RigFeedReceiver.sol](../../src/feed/RigFeedReceiver.sol) | 64 |
| [src/feed/RigReporter.sol](../../src/feed/RigReporter.sol) | 93 |
| [src/interfaces/IBsc.sol](../../src/interfaces/IBsc.sol) | 44 |
| [src/interfaces/ICreditPolicy.sol](../../src/interfaces/ICreditPolicy.sol) | 28 |
| [src/interfaces/ILayerZero.sol](../../src/interfaces/ILayerZero.sol) | 68 |
| [src/interfaces/IRigFeed.sol](../../src/interfaces/IRigFeed.sol) | 20 |
| [src/interfaces/ITapePool.sol](../../src/interfaces/ITapePool.sol) | 44 |
| [src/interfaces/IXLayer.sol](../../src/interfaces/IXLayer.sol) | 110 |
| [src/libraries/CreditMath.sol](../../src/libraries/CreditMath.sol) | 51 |
| [src/libraries/NetlistBuilder.sol](../../src/libraries/NetlistBuilder.sol) | 44 |
| [src/libraries/PolicyV1.sol](../../src/libraries/PolicyV1.sol) | 40 |
| [script/Addresses.sol](../../script/Addresses.sol) | 46 |
| [script/deploy/CheckOldStack.s.sol](../../script/deploy/CheckOldStack.s.sol) | 60 |
| [script/deploy/CheckStack.s.sol](../../script/deploy/CheckStack.s.sol) | 239 |
| [script/deploy/DeployPool.s.sol](../../script/deploy/DeployPool.s.sol) | 83 |
| [script/deploy/ScreenPass.s.sol](../../script/deploy/ScreenPass.s.sol) | 15 |
| [script/feed/CheckFeed.s.sol](../../script/feed/CheckFeed.s.sol) | 40 |
| [script/feed/DeployFeed.s.sol](../../script/feed/DeployFeed.s.sol) | 112 |
| [script/feed/FeedConfig.sol](../../script/feed/FeedConfig.sol) | 17 |
| [script/feed/FeedProbe.s.sol](../../script/feed/FeedProbe.s.sol) | 97 |

Ranh giới thư mục: `src/*.sol`, `src/feed/`, `src/libraries/` và `src/interfaces/` nằm trong phạm vi. Xem xét interface không đồng nghĩa với kiểm toán các triển khai bên ngoài. `src/spike/` chỉ cung cấp bối cảnh; không tuyên bố kiểm toán toàn bộ nguyên mẫu. Chín script triển khai/feed được nêu tên nằm trong phạm vi. Các script khác chỉ cung cấp bối cảnh; đây là phần mở rộng rõ ràng so với mặc định loại script khỏi phạm vi của mẫu báo cáo.

**Out of scope:** app/web, keeper, công cụ chứng minh screen, dịch vụ ngoài chuỗi, ký và lưu giữ khóa, cùng các triển khai đang hoạt động của voucher, vault, factory, PodMining và LayerZero thuộc TapeOut. Kiểm thử hỗ trợ kiểm toán nhưng không phải đối tượng kiểm toán sản xuất. Không lấy về các runbook và tài liệu lịch sử đã bị lược khỏi bản xuất. Các lần đọc bên ngoài kiểm tra một số hành vi, không kiểm tra mọi đường cấp quyền bên ngoài.

**Deployment (private):** đây là bộ hợp đồng dự kiến triển khai lại, trước khi triển khai. Không khẳng định địa chỉ hoặc block nào cho bộ mới này. Địa chỉ trên chuỗi hiện có dùng trong fixture fork không xác định việc triển khai bộ hợp đồng đang được kiểm toán. Báo cáo và tệp thô vẫn riêng tư; chưa được phép công bố.

**Build:** Solidity 0.8.24, Cancun, bật optimizer với 200 runs, OpenZeppelin 5.1.0, Foundry 1.5.1-stable. Các lệnh hiện tại biên dịch ngoại tuyến và ghi artifact build/cache dưới `out/`.

**Tests at the audited code:** người phân loại đã chạy lại thành công 383 kiểm thử đơn vị gốc. Lần đầu chạy các kiểm thử dạng đơn vị, fuzz và fork nhập từ người rà soát có 957 ca đạt và 57 lỗi môi trường. Các lần thử lại có mục tiêu cho kết quả 7 đạt / 7 lỗi, rồi 2 đạt / 0 lỗi. Những kết quả hỗn hợp đó không được gọi là một bộ kiểm thử fork hoàn chỉnh. Không chạy lại toàn bộ đợt kiểm thử fork gốc hoặc bất biến có trạng thái.

| Lần chạy phân loại hiện tại | Đạt | Lỗi | Bỏ qua | Bằng chứng |
|---|---:|---:|---:|---|
| Kiểm thử nhập từ người rà soát và người phản biện | 957 | 57 | 0 | [Log ban đầu](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) |
| Thử lại có mục tiêu qua RPC công khai | 7 | 7 | 0 | [Log thử lại](2026-11-05-redeploy-4-prescan/runs/tests-retry.txt) |
| Thử lại toàn bộ cổng kiểm tra và thư viện | 2 | 0 | 0 | [Thử lại cổng kiểm tra](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) |
| Kiểm thử đơn vị gốc | 383 | 0 | 0 | [Log kiểm thử đơn vị](2026-11-05-redeploy-4-prescan/runs/tests-original-unit.txt) |
| Kiểm thử hồi quy Medium theo quyết định chủ dự án | 2 | 3 lỗi dự kiến | 0 | [Log Medium](2026-11-05-redeploy-4-prescan/runs/tests-owner-medium.txt) |
| Kiểm thử đặc tả hành vi High theo quyết định chủ dự án | 1 | 0 | 0 | [Log High](2026-11-05-redeploy-4-prescan/runs/tests-owner-high.txt) |

Tổng cộng: 1,352 lượt thực thi đạt và 1,346 định danh đường dẫn/hợp đồng/kiểm thử đạt khác nhau. Các lần chạy lặp và kiểm thử kế thừa không phải xác nhận độc lập. Ba lỗi Medium kiểm chứng hành vi mong muốn. Không tuyên bố toàn bộ bộ kiểm thử đều đạt. [Lệnh gốc](2026-11-05-redeploy-4-prescan/runs/RUN-COMMANDS.md) và [lệnh cùng diễn giải sau câu trả lời của chủ dự án](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md) lưu lệnh, đầu ra và giới hạn. GateDryRun chỉ đọc, chạy riêng, thoát với mã 1 như đối chứng âm dự kiến vì một lệnh gọi endpoint bắt buộc không xảy ra.

## Phương pháp

**Tools and roles:** các người rà soát đầu vào dùng gpt-6.1-sol ở xhigh và gpt-6-astra ở high, với các điều chỉnh trình bày bên dưới. Claude Opus 5.5 điều phối bản xuất đầu vào và các phiên. Phiên này biết các lần rà soát trước và viết brief trung lập, không gợi ý trọng tâm. AI Codex phân loại hiện tại đã lần theo mã, tái hiện và viết báo cáo này. Model và effort chính xác của phiên này không được cung cấp dưới dạng dữ kiện rollout có thể kiểm chứng. Chủ dự án là người quyết định ý định và chấp nhận rủi ro. Không tuyên bố có người tái hiện hoặc có kiểm toán độc lập.

**Static scanner provenance:** brief cung cấp Slither 0.11.6 và một lượt rà soát. Log được cung cấp ghi lệnh build sau:

```text
forge build --build-info --deny never --skip ./test/** ./script/** --force
```

Lệnh build bỏ qua các thư mục test và script. Đây là dữ kiện phiên bản và build được cung cấp, không phải kiểm tra cài đặt mới. Người phân loại không cài đặt hoặc chạy lại Slither. Xem [log công cụ rà soát được cung cấp](2026-11-05-redeploy-4-prescan/runs/inputs/slither/slither.txt).

**Separate reader:** một phiên AI Codex mới đã đọc cả bốn bản nháp ngày 2026-11-11 và trả về FAIL với bảy yêu cầu sửa. Người viết đã áp dụng các sửa đổi đó. Người đọc cũng chạy lại kiểm thử hồi quy Medium và kiểm thử đặc tả hành vi High. Đây là xác minh bổ sung, không nằm trong tổng lịch sử của người viết. Xem [READER-1.md](2026-11-05-redeploy-4-prescan/proofs/READER-1.md) và [phản hồi đầu tiên của người viết](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-1.md). Cùng người đọc đó kiểm tra lại các bản sửa và trả về FAIL với một yêu cầu sửa. Người viết đã sửa chủ thể thực hiện phục hồi. Một lần kiểm tra lại nữa vẫn đang chờ. Xem [READER-2.md](2026-11-05-redeploy-4-prescan/proofs/READER-2.md) và [phản hồi thứ hai của người viết](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-2.md).

**Owner decision for the combined audit:** ngày 2026-11-11, chủ dự án xem các đề xuất bằng tiếng Việt của điều phối viên và trả lời, theo bản dịch, **"Phê duyệt đề xuất"**. [OWNER-ANSWERS.md](2026-11-05-redeploy-4-prescan/proofs/OWNER-ANSWERS.md) ghi các đề xuất đã được phê duyệt. Chúng thay thế trạng thái Open mặc định trong brief. Mười phát hiện là Acknowledged, một Medium là Open, và nhận định trước đây về mốc ngừng cho vay là Invalid đối với mã. Không có phát hiện Fixed. Mã nguồn và các tệp SPEC không thay đổi; các sửa câu chữ và cổng kiểm tra đã hứa không được trình bày như bản sửa đã hoàn tất.

**Funnel:** Các nguồn chứa 100 kết quả Slither và các ứng viên đã tổng hợp từ từng đơn vị, không thể khôi phục số lần xuất hiện ban đầu. Sau gộp có 207 nguyên nhân gốc riêng biệt: 11 phát hiện hợp lệ, 0 dưới ngưỡng, 4 đầu mối, 27 rủi ro được chấp nhận, 164 mục bị bác bỏ và 1 nhận định Invalid đối với mã. Tổng là 207.

**Execution accounting:** mười trên mười đơn vị rà soát đều đạt phán quyết chấp nhận cuối cùng mới sau quá trình sửa sai. Những phán quyết đó là đầu vào, không phải quyết định của báo cáo này. Danh sách 94 lượt được cung cấp được in bên dưới, gồm các lần gián đoạn và lượt hiệu chuẩn; không suy diễn thành 94 lượt kiểm toán hoàn chỉnh. Slither có một tiến trình hoàn tất và không có agent. Lần rà soát thông thường trước đó có một phiên và không có nhóm phản biện. Ngoài danh sách đó, không có mẫu số số agent theo từng lần thực thi.

**Triage:** các mục lần lượt xét thực thi tấn công, khả năng đạt tới trạng thái, tác nhân kích hoạt và tác động, theo mục 5 của mẫu. Tuân thủ một câu trong SPEC không miễn trừ việc phá bất biến hoặc tác động kinh tế. Chỉ phạm vi chấp nhận rõ ràng trong mục 16 hoặc sự chấp nhận sau đó của chủ dự án mới làm căn cứ chấp nhận rủi ro. Các trace qua bốn cửa, việc nâng phân loại, tính giới hạn cứng và các chốt chặn bác bỏ vẫn nằm trong [TRIAGE-EVIDENCE.md](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-EVIDENCE.md). Cả 53 dòng conflict/break và 100 kết quả Slither đều giữ ánh xạ. [Dữ liệu quyết định của chủ dự án](2026-11-05-redeploy-4-prescan/runs/owner-decisions.json) giữ cách xử lý ban đầu cùng trạng thái cuối cùng.

### Khoảng trống bao phủ

Bản đối chiếu ledger gốc có 1,493 dòng chứa “undecided”: 83 đã giải quyết, 24 giải quyết một phần và 1,386 chưa giải quyết. Vì vậy 1,410 dòng vẫn có khoảng trống khi phân loại. Trong đó, 1,281 là các dòng trạng thái/thứ tự của system không có kết quả kết hợp được kiểm chứng độc lập. Đây là số dòng, không phải số lỗ hổng. Mọi dòng, nguyên văn, đơn vị đã giải quyết nếu có và tham chiếu chính xác vẫn nằm trong [bản đối chiếu phân loại đầy đủ](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-TABLE.md) và [bản đối chiếu máy đọc được](2026-11-05-redeploy-4-prescan/runs/coverage-reconciliation.json).

Câu trả lời của chủ dự án giải quyết ý định, không bổ sung bằng chứng thực thi còn thiếu. Q1 rút lại các ví dụ số ban đầu. Q3 giải quyết ý định của mốc ngừng cho vay. Q6 chấp nhận các mâu thuẫn câu chữ đã liệt kê. Số dòng gốc được giữ để ghi nhận phạm vi lịch sử; không được trình bày như 1,410 câu hỏi chủ dự án vẫn chưa trả lời. [Lớp cập nhật phạm vi theo câu trả lời chủ dự án](2026-11-05-redeploy-4-prescan/runs/OWNER-COVERAGE-OVERLAY.md) xác định các dòng lịch sử liên quan. Quyết định trong báo cáo này thay thế câu chữ lịch sử về câu hỏi đang chờ trong các tệp đó. Việc chủ dự án chấp nhận rủi ro không tự xác minh trace bên ngoài.

- Lỗi ban đầu của lần chạy hiện tại: 53 phản hồi RPC 403, một phản hồi RPC 429, một lỗi trang RPC lặp lại và hai biến môi trường block fork bị thiếu. Một số setup lỗi khiến nhiều thân kiểm thử không chạy. Các lần thử lại có mục tiêu không giải quyết hết lỗi dữ liệu lưu trữ BSC lịch sử hoặc lỗi X Layer gián đoạn. [Chỉ mục kiểm thử](2026-11-05-redeploy-4-prescan/runs/test-index.json) liệt kê từng lỗi và lần đạt sau đó; [phụ lục lỗi](2026-11-05-redeploy-4-prescan/runs/EXECUTION-GAPS.md) trình bày chúng ở dạng dễ đọc.
- Chưa xác minh toàn bộ danh sách bộ hợp đồng cũ, một số vòng đời đầy đủ nguồn/đích, chuyển trạng thái thu hồi, khoản chi chờ và đường cấp quyền của Safe. Các ca đạt trên fork thật gồm 4,096 vector evaluator, mẫu chuyển/allowance và trả nợ bằng BEM thật, tạo harvest khi hoạt động/dừng, ghi compose/record của voucher và khóa feed. Giả danh endpoint trong fixture không chứng minh xác thực DVN thật.
- App, keeper, công cụ chứng minh, runbook, tài liệu lịch sử, lưu giữ khóa, tập khoản tín dụng cực hạn thực tế và ABI bên ngoài tương lai đều thiếu hoặc chưa được xác minh. Dự báo không phải giới hạn cứng. Không chạy lại các đợt cố ý sửa sai mã của người rà soát trên mã sản xuất đã sửa. Không chạy lại đầy đủ các bộ fork và invariant gốc.
- Không thể khôi phục số “seen in k of N executions” chính xác cho từng mục từ các tệp rà soát tổng hợp. Lượt, đơn vị, kiểm thử sao chép và định danh kế thừa không thay thế số lần thực thi. Các phát hiện nêu cận dưới có bằng chứng; không bịa số chính xác. Slither được cung cấp và lần rà soát thông thường trước đó mỗi loại chỉ có một lượt, thấp hơn quy trình hai lượt mỗi công cụ của mẫu. Đây là khoảng trống quy trình được công khai.
- Dữ kiện điều phối viên cung cấp gồm các lượt sai thiết lập, chấp nhận bị hủy hiệu lực, khởi động lại, dừng do bộ lọc nội dung, lỗi quá tải và người rà soát ban đầu đọc skill đã cài. Toàn bộ được trình bày bên dưới. Phiên phân loại/viết báo cáo này không tải skill đã cài nào.
- Không có ghi nhận con người chạy lại đường khai thác. AI phân loại đã lần theo và chạy lại bằng chứng; chủ dự án quyết định ý định và chấp nhận. Người đọc 1 yêu cầu bảy sửa đổi. Người đọc 2 xác nhận các sửa đổi đó và chỉ ra sai chủ thể phục hồi. Người viết đã sửa chủ thể đó; vẫn chờ kiểm tra lại. Chưa có commit sửa, toàn bộ bộ kiểm thử đạt tại bản sửa, hoặc lần đọc lại bản sửa.

### Giả định tin cậy

- TapeOut Safe dùng cơ chế 3-of-5 và có thể nâng cấp voucher, vault hoặc cứu rig. PodMining có thể nâng cấp. Một lần nâng cấp tạm dừng vay mới và không kích hoạt seize. Voucher có thể có hook trong tương lai.
- Beacon của circuit có thể nâng cấp eval. Netlist được ghim và bản đối chiếu Solidity bảo vệ ranh giới evaluator đã được mô tả.
- Tập DVN của LayerZero sao khớp tập của cầu BEM. Một packet chưa được xác minh có thể chặn các báo cáo sau.
- Chủ dự án chọn tham số trung thực. Khóa owner hoặc guardian bị đánh cắp vẫn phải tuân theo giới hạn tài sản, khoản vay, timelock và phanh đã cam kết.
- Một screen pass ghi nhận bằng chứng ngoài chuỗi. Kiểm toán này không chạy lại công cụ chứng minh screen.
- Power của voucher trên X Layer gồm bonus thiết kế và được cập nhật khi harvest.
- BEM có tám chữ số thập phân và không có phí chuyển. Các mẫu fork thật hỗ trợ giả định này; thay đổi metadata giả định vẫn là đầu mối.
- Harvest trả cho người giữ tại thời điểm gửi harvest từ BSC, không phải khi nó đến đích.
- Q5 của chủ dự án giới hạn miền báo giá được hỗ trợ ở v1 và factory của chính pool. Rà soát bản thay thế và đối chiếu runtime bên ngoài là hoạt động do chủ dự án xác nhận, nằm ngoài bản xuất này.

Một cuộc kiểm toán độc lập được lên kế hoạch sau hackathon.

### Toàn bộ dữ kiện chuẩn bị được cung cấp

Bốn tệp nguồn sau được chép lại không lược bỏ. Các phát biểu trong đó là dữ kiện do điều phối viên cung cấp, không phải xác minh mới của người viết. Hàm băm lịch sử trong dữ kiện hiệu chuẩn và so sánh chỉ là bối cảnh; báo cáo này chỉ kiểm toán `ceed0a2`. Việc bắt buộc giữ nguyên nguồn gốc này là ngoại lệ được nêu rõ đối với nghĩa đen của mục kiểm tra “one commit named”. Các đường dẫn ngoài thư mục này là dữ kiện được trích lại và không được truy cập.

<details>
<summary>INPUT-DISCLOSURE.md</summary>

# Những gì các phiên rà soát mù được thấy (redeploy 4, trước triển khai, dành cho phần Phương pháp của báo cáo)

Phiên điều phối chuẩn bị ngày 2026-11-05. O4-3 của `docs/SPEC-REDEPLOY-4.md`, được chủ dự án phê duyệt ngày 2026-11-05, dự kiến bước này gồm hai lượt Claude, một lượt Codex được dùng Forge, Slither và phân loại nội bộ trên commit đã đóng băng. Cùng ngày, chủ dự án đổi sang chỉ dùng Codex (Sol 6.1 xhigh và Astra high) dưới sự giám sát của phiên này: xem SCAN-FACTS.md. Mọi phát hiện High hoặc Medium đều phải quay lại bước xây dựng trước RD4-03.

- **Audited commit.** `ceed0a2` trên nhánh `redeploy-v4`. Chưa triển khai. Các phần A, B và C đã đạt kiểm toán cuối bằng Fable 5.1 trước đợt rà soát này.
- **Ai chuẩn bị bản xuất.** Phiên điều phối biết các rà soát trước, đặc tả và các bản sửa, nên không tham gia tìm lỗi, xác minh hay phân loại, và không viết báo cáo. Phiên này tạo bản xuất, chạy build, kiểm thử và Slither, viết brief, giám sát các phiên và không tự thêm nội dung rà soát. Các brief mô tả quy trình, không gợi ý trọng tâm.
- **`docs/SPEC.md` đã sửa cho redeploy 4**, với các thay đổi sau (nội dung chuẩn tắc không đổi):
  - bỏ các liên kết đến tài liệu đặc tả redeploy và ghi chú build;
  - bỏ các id yêu cầu và quyết định (`R4-xx`, `RB4-xx`, `RD4-xx`, `O4-x`, `R3-xx`, `RA-xx`, `RB-xx`, `RB3-xx`, `RD-xx`, `O-x`, `O3-x`, `D-4`, `D-O1`, `G-xx`), thay bằng "the keeper" hoặc "the deploy runbook" khi id chỉ quy tắc tương ứng;
  - bỏ nhãn phiên bản đặc tả (`v4`, `v5`), "Part A re-audit L-04" và "gap check U3";
  - bỏ §17 (nơi đặc tả đóng băng được áp dụng và sửa đổi);
  - rút ngắn câu mở đầu Annex. Annex giữ các định nghĩa, dòng và quyết định.
  - Script là `scrub-spec4.cjs`. Quét theo mẫu trên kết quả không tìm thấy id nào trong số đó.
  - §16 giữ các dòng rủi ro được chấp nhận, kể cả các dòng thêm cho lần redeploy này. Vì vậy phiên rà soát đọc được rằng các rủi ro đã được chấp nhận, và biết phần nào đã đổi từ những dòng ghi "Redeploy 4".
- **`docs/SECURITY-AUDIT-TEMPLATE.md`** tại `ceed0a2`, với bảng giá trị đang dùng và các dòng đã sửa về thoát, giá cổ phần, owner và dữ liệu cũ.
- **`src/` nguyên văn**, để giữ đối chiếu bytecode và metadata. NatSpec viện dẫn id yêu cầu, như `R3-xx` trong `RigAgent.sol` và `TapePool.sol`, cùng chữ cái chỉ dòng.
- **Kiểm thử và script.** Giữ các kiểm thử thông thường và NatSpec của chúng. Tên tệp và kiểm thử như `Redeploy4Evidence`, `Redeploy4Custody`, `Redeploy4Reserve`, `Redeploy4Bonus`, `Redeploy4Rehearsal` và các tệp `Redeploy3*` tương ứng với phần thay đổi trong mỗi redeploy. Sửa các chú thích nhắc rà soát trước, giữ nguyên mã kiểm thử (`sanitize4.cjs`):
  - `script/app/ParityVectors.s.sol`: "(v5, L-04)", "v5 (L-04)";
  - `test/fork/Redeploy4Bonus.t.sol`: "the H-01 reproduction";
  - `test/invariant/PoolHandler.sol`: "(L-04)";
  - `test/mocks/Hostile.sol` và `test/unit/Rounding.t.sol`: liên kết đến đặc tả rà soát Phase 4;
  - `test/unit/EdgeCases.t.sol`: "added after audit round 1" và sáu nhãn "round 1, finding N";
  - `test/unit/PolicyIntegration.t.sol`: "review finding F6";
  - `test/unit/Redeploy3EvidenceTable.t.sol`: "(v5, L-04)", "(L-04)";
  - `test/unit/Redeploy3StoredImpaired.t.sol`: "The final audit's L-01", "L-04".
  Các chú thích khác giữ tham chiếu đặc tả như `R4-xx`, `SPEC-PHASE3 §…`, `DERISK Q…` và `RD3-0x`.
- **`foundry.toml`**: bỏ khối `[fmt]` bỏ qua một tệp dưới `test/audit/` và chú thích nhắc rà soát ngày 2026-11-01. Thiết lập build không đổi.
- **`CLAUDE.md` nguyên văn** tại `ceed0a2`. Các bảng địa chỉ trong đó nêu bộ hợp đồng ngày 2026-10-21.
- **Đã bỏ:** `test/audit/`, `test/unit/ConformanceMatrix.t.sol`, mọi tài liệu khác, `app/`, `keeper/`, `screen/`, `research/`, `broadcast/`, `.github/`, `README.md`, `app-dev.cmd` và lịch sử git.
- **Dependency:** sao chép `lib/` từ các submodule của checkout build nhưng bỏ liên kết `.git`; `node_modules/` theo `package-lock.json`. `.env` trong các thư mục rà soát chỉ chứa endpoint công khai.
- **Cách ly phiên.** Mỗi phiên rà soát làm việc trong thư mục riêng bên ngoài repository, và tắt bộ nhớ Codex. Các lần đọc không bị sandbox giới hạn. Sau đó kiểm tra log để tìm lần đọc ngoài thư mục, và kiểm tra rollout về model cùng effort của mỗi lượt.
- **Biết rằng có các rà soát trước.** Brief nói rõ điều đó và cấm tìm chúng. Chủ dự án đã rà soát cơ sở mã này nhiều lần, và bản xuất không thể che giấu việc mã đã được rà soát.
- **Lượt Codex đầu tiên (`codex-1`).** Trước thay đổi của chủ dự án: một lần rà soát thông thường qua CLI trong bản xuất riêng, có Forge và không có mạng, khoảng 21 phút, không có phát hiện. Dữ kiện nằm trong CODEX-PASS-FACTS.md. `.env` của bản đó chứa URL RPC có khóa; tìm trong log không thấy dấu hiệu phiên đã đọc chúng. Sau đó mười đơn vị chạy với endpoint công khai và có mạng.

</details>

<details>
<summary>CALIBRATION.md</summary>

# Hiệu chuẩn phương pháp rà soát Codex (2026-11-05), dành cho phần Phương pháp của báo cáo

Trước khi rà soát `ceed0a2`, phiên điều phối chạy cùng phương pháp trên commit `e710426`, bộ hợp đồng ngày 2026-11-02 có lỗi đã biết từ rà soát ngày 2026-11-04. Các phiên không được báo đây là hiệu chuẩn. Chỉ có hai đơn vị, vì mục tiêu là hai lỗi High và Medium mà các lượt Codex trước chưa xác lập. Thư mục: `D:\TapePool-blind4\codex\o-feed`, `o-evidence`.

| Lỗi đã biết (rà soát 2026-11-04) | Đơn vị | Kết quả |
|---|---|---|
| H-01 High, `bonus` thô cạnh `verifWeight` đã nhân mult | feed | Sol **tìm thấy ở mức High** sau khoảng 15 phút, bằng đọc trực tiếp ba miner Behemoth, cùng số với rà soát (circuit 52: weight 48, base 24) và một kiểm thử policy. Astra đang rà soát đơn vị khác cũng tự tìm thấy (C-01 của nó) |
| L-03 Low, cùng nguyên nhân gốc với H-01 | feed | Được bao phủ bởi cùng phát hiện |
| M-01 Medium, phanh feed bỏ dòng B và U khi clear | agent-evidence | **Tìm thấy dưới dạng đầu mối, không phải phát hiện.** Sol tái hiện đúng chuỗi bằng kiểm thử (khôi phục 1 BEM gốc bị đánh dấu doubtful, redeem thêm 0.53 BEM). Nó không chấm mức vì câu chữ đặc tả tại commit đó cho phép hành vi. Astra giữ dưới dạng đầu mối chưa chấm mức và bác bỏ việc phá trực tiếp bất biến 16 |
| L-02 Low, câu trả lời `ownerOf` bằng zero trở thành bằng chứng | feed | **Không báo cáo.** Sol kiểm thử trường hợp đó và ghi là tuân thủ, vì đặc tả tại commit đó không cấm |
| L-01 Low và L-04 Low | không nằm trong hai đơn vị này | Không đo lường |

**Điều này cho biết gì về phương pháp.**

- Nó tìm được điều các lượt Codex trước không tìm ra: các lần đọc trực tiếp và bảng đơn vị đã nhanh chóng dẫn tới H-01.
- Phương pháp yếu khi mã tuân theo một câu trong đặc tả nhưng lỗi nằm ở điều câu đó cho phép. Cả các lỗi bỏ sót lẫn đầu mối chưa chấm mức đều thuộc dạng này. Vì vậy không đầu mối nào được để nguyên chưa chấm mức: phân loại xét từng đầu mối theo §15, §8 và §5 của mẫu, và chủ dự án thấy tất cả.
- Bộ lọc đã dừng phiên feed của Sol hai lần. Một phiên mới đọc các tệp đã lưu và hoàn tất đơn vị, nên việc dừng chỉ tốn thời gian, không mất phạm vi bao phủ.
- Đây là hai đơn vị trên một commit, nên chỉ kiểm tra rằng phương pháp hoạt động, không phải phép đo tỷ lệ phát hiện.

</details>

<details>
<summary>SCAN-FACTS.md</summary>

# Dữ kiện về đợt rà soát Codex đối với `ceed0a2`, dành cho phần Phương pháp của báo cáo

Phiên điều phối Claude Opus 5.5 chuẩn bị từ log phiên và rollout của chính Codex.

## Đợt rà soát đã thay đổi thế nào

O4-3 của `docs/SPEC-REDEPLOY-4.md` dự kiến hai lượt Claude, một lượt Codex, Slither và phân loại nội bộ. Ngày 2026-11-05, chủ dự án thay đổi, theo bản dịch từ tiếng Việt: "OK, chạy rà soát mù, nhưng lần này bạn điều phối Codex rà soát và giám sát để nó không làm qua loa. Lần trước nó chỉ rà soát 30 phút mà không tìm thấy lỗi. Chỉ dùng Sol 6.1 xhigh và Astra high." Vì vậy không chạy lượt Claude nào. Chỉ `gpt-6.1-sol` ở xhigh và `gpt-6-astra` ở high được rà soát, còn phiên này điều phối và giám sát. Phiên này biết các rà soát trước và bản sửa, và viết brief trung lập không gợi ý trọng tâm. Danh sách đơn vị được chia theo cấu trúc mã và các mục đặc tả.

## Phương pháp

- Mười đơn vị, mỗi đơn vị một phiên Sol, chỉ RPC công khai, ledger bốn bảng và cổng kiểm tra cơ học (`gate.cjs`): dòng, tham chiếu, kiểm thử được viện dẫn phải đạt, hàm băm mã nguồn.
- Mỗi đơn vị có một Astra làm người rà soát thứ hai: tự đọc trước, rồi lấy mẫu, cố ý sửa sai trong bản nháp và đưa ra ACCEPT hoặc RETURN. Các mục bị trả lại quay về Sol.
- Hiệu chuẩn trước trên commit cũ hơn: xem `CALIBRATION.md`.

## Sai sót của điều phối viên và những gì bị hủy hiệu lực

Script điều khiển đầu tiên chỉ truyền model và effort khi bắt đầu phiên, không truyền khi tiếp tục phiên. Sau đó `codex exec resume` chạy `gpt-6.1-sol` ở effort mặc định, ngay cả trong thread Astra. Ngày 2026-11-05, điều phối viên phát hiện bằng cách đọc `turn_context` của từng lượt từ rollout, dừng chạy, báo chủ dự án và sửa script.

- **29 trong 60 lượt đầu chạy sai thiết lập.** Chúng gồm mọi câu trả lời Sol cho vòng trả lại đầu tiên trừ một, gần hết các lần Astra kiểm tra lại vòng đầu, phần cuối bốn rà soát Astra đầu tiên (`agent-evidence`, `feed`, `pool-loans`, `deploy`), toàn bộ ledger `pool-admin` của Sol và phần cuối ledger `system` của Sol.
- **Mọi `VERDICT: ACCEPT` trước đó trên những đơn vị này đều vô hiệu.** Chấp nhận duy nhất được viết ở đúng thiết lập trước khi sửa là của `deploy`, nhưng dựa trên công việc chạy sai thiết lập nên cũng được làm lại.
- **Làm lại.** Sol ở xhigh kiểm tra lại phần bị ảnh hưởng của từng đơn vị (`out/REDO-NOTE.md` ghi rõ), và toàn bộ `pool-admin`. Sau đó một Astra mới ở high rà soát từng đơn vị, coi mọi báo cáo trước là đầu vào, rồi tiếp tục các vòng trả lại.
- **Sau khi sửa, có thêm 34 lượt chạy và không lượt nào sai thiết lập** (xem bảng). Cả mười đơn vị kết thúc với `VERDICT: ACCEPT` từ những lượt này. Tệp chạy sai thiết lập trước đó vẫn nằm trong `out/` của mỗi đơn vị, có nhãn theo lượt.
- Hiệu chuẩn không bị ảnh hưởng: lượt sai thiết lập duy nhất (`o-feed sol-t2`) dừng ở bộ lọc nội dung, và kết quả lấy từ các lượt đúng thiết lập.

## Gián đoạn

- Chủ dự án khởi động lại máy hai lần ngày 2026-11-05, lúc 10:45 và 13:18 UTC (log sự kiện Windows). Các phiên bị ngắt giữa lượt và tiếp tục từ tệp đã lưu.
- Một phiên Claude kết thúc khiến driver dừng khoảng 18:34 UTC, và nó đứng yên đến 02:45 UTC ngày 2026-11-06.
- Số lần bộ lọc nội dung dừng và lỗi "model at capacity" được đếm bên dưới. Sau lần bộ lọc dừng, một phiên mới đọc tệp đã lưu để tiếp tục.

## Giới hạn

- Các lần đọc không bị sandbox giới hạn. Brief cấm các thư mục khác, và log được kiểm tra sau đó: số lệnh nêu đường dẫn ngoài thư mục phiên nằm bên dưới. Phép rà này đối sánh mẫu trên các lệnh shell.
- Các phiên đầu tự tải skill `security-audit` đã cài. Brief cho mười đơn vị cấm điều này và các lượt sau không tải, nhưng một số lượt phản biện đầu tiên đã tải, như số đếm bên dưới.
- Fork dùng endpoint công khai: X Layer `rpc.xlayer.tech` và BSC `bsc-rpc.publicnode.com`, nơi không lưu trạng thái cũ hơn khoảng 20,000 block. Không URL có khóa nào được đưa tới phiên.
- Mã ngoài chuỗi (keeper, app, công cụ screen) không nằm trong đợt rà soát này. Nó đã đạt kiểm toán cuối riêng.
- **Slither:** một lần chạy trên bản xuất, 100 kết quả, không có kết quả mới so với lần chạy tại `e7c2bb5`.

## Theo từng lượt

Lượt của các phiên: 94. Lệnh shell: 3707. Lần chạy forge test: 358. Lần bộ lọc nội dung dừng: 4. Lỗi model quá tải: 9. Lượt có log chứa host RPC có khóa: 0. Lệnh đọc skill security-audit đã cài: 26.

```text
ok  agent-evidence  sol-t1           gpt-6.1-sol/xhigh        completed
ok  agent-evidence  astra-c1         gpt-6-astra/high         cut off
BAD agent-evidence  astra-c2         gpt-6.1-sol/default      completed
BAD agent-evidence  sol-r1-1         gpt-6.1-sol/default      completed
BAD agent-evidence  astra-k1-1       gpt-6.1-sol/default      completed
ok  agent-evidence  sol-v-1          gpt-6.1-sol/xhigh        completed
ok  agent-evidence  astra-w-1        gpt-6-astra/high         failed
ok  agent-evidence  astra-w-2        gpt-6-astra/high         completed
ok  agent-loan      sol-t1           gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-c1         gpt-6-astra/high         completed
BAD agent-loan      sol-r1-1         gpt-6.1-sol/default      cut off
BAD agent-loan      sol-r1-2         gpt-6.1-sol/default      completed
BAD agent-loan      astra-k1-1       gpt-6.1-sol/default      completed
ok  agent-loan      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-w-1        gpt-6-astra/high         completed
ok  agent-loan      sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-y1-1       gpt-6-astra/high         completed
ok  deploy          sol-t1           gpt-6.1-sol/xhigh        completed
ok  deploy          astra-c1         gpt-6-astra/high         cut off
BAD deploy          astra-c2         gpt-6.1-sol/default      completed
BAD deploy          sol-r1-1         gpt-6.1-sol/default      completed
BAD deploy          astra-k1-1       gpt-6.1-sol/default      failed
ok  deploy          astra-k1-2       gpt-6-astra/high         failed
ok  deploy          astra-k1-3       gpt-6-astra/high         completed
ok  deploy          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  deploy          astra-w-1        gpt-6-astra/high         completed
ok  deploy          sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  deploy          astra-y1-1       gpt-6-astra/high         completed
ok  feed            sol-t1           gpt-6.1-sol/xhigh        completed
ok  feed            astra-c1         gpt-6-astra/high         cut off
BAD feed            astra-c2         gpt-6.1-sol/default      completed
BAD feed            sol-r1-1         gpt-6.1-sol/default      completed
BAD feed            astra-k1-1       gpt-6.1-sol/default      completed
ok  feed            sol-v-1          gpt-6.1-sol/xhigh        completed
ok  feed            astra-w-1        gpt-6-astra/high         failed
ok  feed            astra-w-2        gpt-6-astra/high         completed
ok  lens-factory    sol-t1           gpt-6.1-sol/xhigh        failed
ok  lens-factory    sol-t2           gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-c1         gpt-6-astra/high         completed
BAD lens-factory    sol-r1-1         gpt-6.1-sol/default      completed
BAD lens-factory    astra-k1-1       gpt-6.1-sol/default      completed
ok  lens-factory    sol-v-1          gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-w-1        gpt-6-astra/high         completed
ok  lens-factory    sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-y1-1       gpt-6-astra/high         cut off
ok  lens-factory    astra-y1-2       gpt-6-astra/high         completed
ok  o-evidence      sol-t1           gpt-6.1-sol/xhigh        completed
ok  o-evidence      astra-c1         gpt-6-astra/high         completed
ok  o-feed          sol-t1           gpt-6.1-sol/xhigh        failed
BAD o-feed          sol-t2           gpt-6.1-sol/default      failed
ok  o-feed          sol-t3           gpt-6.1-sol/xhigh        completed
ok  policy          sol-t1           gpt-6.1-sol/xhigh        completed
ok  policy          astra-c1         gpt-6-astra/high         completed
BAD policy          sol-r1-1         gpt-6.1-sol/default      cut off
BAD policy          sol-r1-2         gpt-6.1-sol/default      completed
BAD policy          astra-k1-1       gpt-6.1-sol/default      completed
ok  policy          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  policy          astra-w-1        gpt-6-astra/high         completed
ok  pool-admin      sol-t1           gpt-6.1-sol/xhigh        cut off
BAD pool-admin      sol-t2           gpt-6.1-sol/default      completed
ok  pool-admin      astra-c1         gpt-6-astra/high         completed
BAD pool-admin      sol-r1-1         gpt-6.1-sol/default      cut off
BAD pool-admin      sol-r1-2         gpt-6.1-sol/default      completed
BAD pool-admin      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-admin      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  pool-admin      astra-w-1        gpt-6-astra/high         failed
ok  pool-admin      astra-w-2        gpt-6-astra/high         completed
ok  pool-books      sol-t1           gpt-6.1-sol/xhigh        completed
ok  pool-books      astra-c1         gpt-6-astra/high         completed
BAD pool-books      sol-r1-1         gpt-6.1-sol/default      failed
ok  pool-books      sol-r1-2         gpt-6.1-sol/xhigh        completed
BAD pool-books      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-books      astra-w-1        gpt-6-astra/high         completed
ok  pool-books      sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  pool-books      astra-y1-1       gpt-6-astra/high         completed
ok  pool-loans      sol-t1           gpt-6.1-sol/xhigh        completed
ok  pool-loans      astra-c1         gpt-6-astra/high         cut off
BAD pool-loans      astra-c2         gpt-6.1-sol/default      completed
BAD pool-loans      sol-r1-1         gpt-6.1-sol/default      completed
BAD pool-loans      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-loans      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  pool-loans      astra-w-1        gpt-6-astra/high         completed
ok  system          sol-t1           gpt-6.1-sol/xhigh        cut off
BAD system          sol-t2           gpt-6.1-sol/default      completed
ok  system          astra-c1         gpt-6-astra/high         failed
ok  system          astra-c2         gpt-6-astra/high         failed
ok  system          astra-c3         gpt-6-astra/high         failed
ok  system          astra-c4         gpt-6-astra/high         completed
BAD system          sol-r1-1         gpt-6.1-sol/default      cut off
ok  system          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  system          astra-w-1        gpt-6-astra/high         failed
ok  system          astra-w-2        gpt-6-astra/high         completed
ok  system          sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  system          astra-y1-1       gpt-6-astra/high         completed

turns 94, wrong setting 29
```

## Lệnh nêu đường dẫn ngoài thư mục phiên: 0

</details>

<details>
<summary>CODEX-PASS-FACTS.md</summary>

# Lượt Codex (2026-11-05), dữ kiện phục vụ phân loại

Phiên điều phối đọc từ các tệp của chính lượt đó.

- **Output:** `D:\TapePool-blind4\codex-1\out\` (`FINDINGS.md`, `COVERAGE.md`, `tests\SpecReview.t.sol`, đầu ra kiểm thử, `session.jsonl`).
- **Result:** 0 phát hiện ở mọi mức Severity, 0 đầu mối. Tệp phạm vi liệt kê 227 mục ABI public và external.
- **Model:** `gpt-6.1-sol` ở xhigh qua Codex CLI, một phiên, từ 07:56:32 đến 08:17:07 UTC (khoảng 21 phút). `session.err` trống nên không ghi nhận lần dừng do bộ lọc.
- **Execution:** Forge đã chạy: 434 kiểm thử đạt, trong đó 21 là kiểm thử rà soát mới của phiên. Sandbox không có mạng nên không chạy kiểm thử fork nào. Việc khóa feed chỉ được lần theo mã nguồn. Chưa xác minh hành vi TapeOut trực tiếp hoặc nội bộ LayerZero.
- **Blindness:** thư mục làm việc là bản xuất riêng của phiên. Quét theo mẫu trên 39 lệnh shell không thấy đọc repository, thư mục TapePool khác, báo cáo trước, thư mục Codex hay Claude, hoặc URL nào.
- **Framing:** rà soát thông thường đối chiếu đặc tả, vì cách đặt bài toán đối kháng từng bị bộ lọc của model này chặn. Không dùng skill `security-audit`. Kết quả 0 chỉ thuộc một lượt với các giới hạn đó, không phải chứng nhận không có lỗi.

</details>

## Phân loại rủi ro

Severity tuân theo [mục 4 của mẫu](../SECURITY-AUDIT-TEMPLATE.md) và giới hạn cứng trong mã, không theo thiết lập khi ra mắt. Critical bao gồm mất gốc hoặc quyền hạn không bị hạn chế. High bao gồm mất tài sản có điều kiện hoặc vượt giới hạn đã cam kết. Medium bao gồm thiệt hại có giới hạn hoặc quy tắc fail-open hiếm nhưng có thể đạt tới. Low bao gồm phạm vi hẹp, lượng bụi và view sai. Confidence là thang riêng. Việc chủ dự án xác nhận chấp nhận không hạ Severity.

## Các phát hiện

### High Severity

#### [H-01] Thu nhập khôi phục vượt giới hạn phân bổ được nêu ban đầu

**Merge key:** `TapePool._restore:restored-income-redistribution-bound`

**Severity:** High · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** system. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapePool.sol:820](../../src/TapePool.sol). Căn cứ nguồn: system/FINDINGS.md I-01, L-01, F5-B; system/LEDGER.md R16-24.5.

**Summary**

Pool khôi phục thu nhập đã hấp thụ để giải phóng cho người giữ cổ phần hiện tại. Người gửi tiền vào sau có thể nhận nhiều hơn giới hạn 122 BEM ban đầu trong mục 16 của SPEC. Chủ dự án hiện chấp nhận giới hạn đã sửa mà không đổi mã.

**Impact**

Người vào sau trong tái hiện nhận 249.44962306 BEM từ 499.94957010 BEM thu nhập khôi phục, khoảng 49.895% khoản đó. Hành vi này phân bổ lại thu nhập từ người giữ trước; không chứng minh việc lấy cắp gốc đã trả. Trong mỗi lần khôi phục, thu nhập chia sẻ không vượt thu nhập đã hấp thụ hoặc gốc bị đánh dấu: giới hạn cứng 500 BEM, khi ra mắt 8 BEM. Các lần khôi phục lặp lại không có trần tổng suốt vòng đời. Giới hạn được chấp nhận đã bị ghi sai khi rà soát. Các ví dụ 0.0046 và 4.3 BEM ban đầu bị rút lại, không được tái hiện.

**Severity basis:** High theo mục 4 của mẫu: người cho vay trước mất phần phân bổ với điều kiện bắt buộc là thu nhập đã hấp thụ được khôi phục. Sự chấp nhận của chủ dự án đổi Status, không đổi Severity.

**Exploit Path**

1. Chủ dự án tăng hạn mức qua thời gian chờ thực tế lên 1,000 BEM cung và 500 BEM vay.
2. Một agent cũ đã bị seize nhận rồi chuyển tiếp 500 BEM. Hai khoản vay thật, mỗi khoản 250 BEM, bị đánh dấu doubtful và hấp thụ 499.94957010 BEM thu nhập.
3. Một người gọi xóa cả hai cờ hết hạn bằng bằng chứng khỏe. Người cho vay vào sau gửi 498.94957009 BEM trước khi thu nhập khôi phục được giải phóng.
4. Người cho vay đợi giải phóng rồi redeem, thu lợi 249.44962306 BEM.

**Prerequisites**

Thu nhập đã hấp thụ phải được khôi phục sau khi xóa dấu. Fixture dùng policy v1 thật, rig giả lập 20,000 H đã qua screen và giữ lại vốn backstop. Chưa xác lập tập rig thực tế ở quy mô đó. Người vào sau không cần vai trò đặc quyền.

**Proof**

Kiểm thử đặc tả giá trị chính xác đạt lại trong tests-owner-high.txt. Không có kiểm thử hành vi mong muốn bị lỗi vì chủ dự án chấp nhận hành vi tại giới hạn đã sửa. Kiểm thử ép giới hạn 122 BEM sẽ kiểm chứng yêu cầu đã rút lại. Đây là ngoại lệ có nêu lý do trong mục 7 của mẫu; nó khác yêu cầu ban đầu buộc mọi trường hợp phải có kiểm thử lỗi.

- [test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](2026-11-05-redeploy-4-prescan/runs/tests/system/review/RestoreAmount.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

[Lần chạy lại sau câu trả lời chủ dự án và ngoại lệ đã nêu](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md) cùng [đầu ra chạy lại thô](2026-11-05-redeploy-4-prescan/runs/tests-owner-high.txt).

**Recommendation**

Không đổi mã theo chỉ đạo của chủ dự án. Sửa mục 16 của SPEC theo giới hạn mỗi lần khôi phục đã chấp nhận và bỏ các ví dụ đã rút lại. Không sửa tệp đặc tả nào trong bản work bị giới hạn này.

**Resolution**

Q1 của chủ dự án: Acknowledged tại giới hạn đã sửa, không đổi mã. Giới hạn chấp nhận bị ghi sai khi rà soát. Mỗi lần khôi phục, thu nhập chia sẻ không vượt thu nhập đã hấp thụ, không vượt gốc bị đánh dấu: giới hạn cứng 500 BEM, khi ra mắt 8 BEM. Các lần khôi phục lặp lại không có trần tổng suốt vòng đời. Các ví dụ 0.0046 và 4.3 BEM bị rút lại.

### Medium Severity

#### [M-01] Báo cáo bị bỏ làm bằng chứng khỏe cũ của voucher có hiệu lực lại

**Merge key:** `RigAgent._verdict:discarded-report-revives-old-health`

**Severity:** Medium · **Status:** Fixed · **Confidence:** 75

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** feed. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/RigAgent.sol:664](../../src/RigAgent.sol). Căn cứ nguồn: feed/CRITIC-3.md C3-01/C3-02; RigAgent.sol:664–688.

**Summary**

Agent phải đòi bằng chứng khỏe trước khi khôi phục gốc doubtful. Khi feed bật, nó bỏ báo cáo không suy giảm nhưng cũ hoặc không hợp lý. Bản ghi voucher dương cũ hơn sau đó có thể xóa cờ hết hạn.

**Impact**

Chuỗi cục bộ khôi phục 1 BEM mà không có bằng chứng khỏe từ báo cáo mới hoặc bản ghi dương mới hơn. Tại giới hạn cứng, tối đa 500 BEM gốc đang vay có thể bị khôi phục sai. Mọi lần rút sau đó còn cần BEM nhàn rỗi và cổ phần. Chưa xác lập trace hoàn chỉnh đã xác thực từ bên tạo báo cáo đến tổn thất người cho vay. Cũng chưa xác lập chuyển đổi thượng nguồn từ hợp lý sang không hợp lý; hai biến thể có cùng nguyên nhân.

**Severity basis:** Medium theo mục 4 của mẫu: quy tắc fail-closed bị fail-open trong trạng thái hiếm nhưng đạt tới được. Confidence giữ ở 75 theo quy tắc nâng phân loại trace chưa hoàn tất của mục 5; tái hiện cục bộ chưa hoàn tất đường tổn thất bên ngoài.

**Exploit Path**

1. Người vay có khoản vay 1 BEM đã bị gắn cờ. Bản ghi voucher dương tại mốc seize bị báo cáo suy giảm mới hơn đang lưu lấn át.
2. Receiver nhận báo cáo không suy giảm còn mới hơn sau khi hết độ mới, hoặc nhận báo cáo không nhất quán.
3. Agent giữ reported là false cho báo cáo đó. Bản ghi voucher dương cũ hơn trở thành ứng viên duy nhất.
4. Bất kỳ người gọi nào xóa cờ hết hạn, và pool khôi phục gốc doubtful.

**Prerequisites**

Cờ đã hết hạn, feed bật và báo cáo nằm tại hoặc sau các mốc bằng chứng và bật feed. Có bản ghi voucher dương tại hoặc trước timestamp của báo cáo. Tái hiện dùng endpoint cục bộ và bản ghi giả lập cùng receiver, policy, pool và agent thật.

**Proof**

OwnerEvidenceRegression.t.sol kiểm chứng việc từ chối các trường hợp báo cáo cũ, không hợp lý và bản ghi dương cùng timestamp. Cả ba lỗi trên mã được kiểm toán vì clearExpiredFlag không revert. Đối chứng power bằng zero và bản ghi dương mới hơn hẳn đều đạt. Xem tests-owner-medium.txt và POST-OWNER-RUNS.md. Không có commit sửa được cung cấp hoặc kiểm thử.

- [test_critic3StaleHealthyDeliveryErasesBlockAndRevivesOlderRecord()](2026-11-05-redeploy-4-prescan/runs/tests/feed/critic/Critic3Sequences.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

[Kiểm thử hành vi mong muốn](../../test/audit/2026-11-05-redeploy-4-prescan/owner/OwnerEvidenceRegression.t.sol) và [bản ghi lệnh/đầu ra chính xác](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md).

**Recommendation omitted:** mục 5 của mẫu cấm khuyến nghị suy đoán khi trace bên ngoài được nâng phân loại vẫn chưa hoàn tất.

**Owner-approved intended behaviour:** Chủ dự án yêu cầu bằng chứng unknown cho các báo cáo bị bỏ này. Bản ghi dương sync tại hoặc trước báo cáo không được quyết định. Bản ghi power bằng zero tại hoặc sau mốc vẫn phải quyết định là suy giảm. Đây là hành vi được phê duyệt, không phải bản vá suy đoán cho trace bên ngoài chưa hoàn tất.

**Resolution**

Đã sửa trong `7fce86e`. R4-08 của `docs/SPEC-REDEPLOY-4.md` (quyết định O4-14 của chủ dự án) thêm row N: một report không impaired, tại hoặc sau cả hai floor, mà không vừa fresh vừa sane thì đọc là unknown. Unknown chặn clear trên mọi rig collateral, nên một bản ghi dương cũ hơn không còn quyết định. Một bản ghi power 0 tại hoặc sau floor vẫn quyết định impaired. Keeper phản chiếu row N trong `d14585d` (RB4-08). Năm test của `OwnerEvidenceRegression.t.sol` pass từ `7fce86e` trở đi. Khi khôi phục các nhánh `_verdict` cũ, ba test hồi quy an toàn của nó fail. Toàn bộ bộ test Forge (unit, fork, invariant) xanh tại `4bac093`, nơi `src/` giống hệt bản build cuối (`docs/redeploy-4/acceptance-v13.md`). Audit cuối của Part A2 (AI, Claude Fable 5.2) đã đọc lại bản sửa và cho PASS. Audit cuối của keeper (AI, Claude Fable 5.2) cho FAIL RB4-08 ở vòng 1, và bản tiếp theo RB4-09 PASS ở vòng 4 không còn phát hiện nào. Chủ dự án duyệt freeze trong chat ngày 2026-11-14. Commit được audit `ceed0a2` chưa bao giờ được deploy.

### Low Severity

#### [L-01] Lượng cổ phần lớn khiến mint nhỏ bị revert

**Merge key:** `TapePool.maxMint:share-conversion-overflow`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** pool-books. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapePool.sol:269](../../src/TapePool.sol). Căn cứ nguồn: pool-books/FINDINGS.md L-C1; CRITIC-1 L-C1; LEDGER C09/P02.

**Summary**

Pool tính maxMint từ toàn bộ hạn mức cung còn lại. Tổn thất và tái cấp vốn lặp lại có thể làm phép chuyển đổi đó tràn số. Người gọi không thể mint dù chỉ một cổ phần, trong khi phép chuyển riêng của nó vẫn biểu diễn được.

**Impact**

Đường mint và view giá trị tối đa bị revert sau chín chu kỳ tổn thất đã chứng minh. Deposit vẫn hoạt động, và tặng một đơn vị BEM thô rồi giải phóng sau một giây sửa được trạng thái thử nghiệm. Không chứng minh mất thêm gốc hoặc chặn hoàn toàn đường thoát. Hạn mức cung cứng 1,000 BEM không giới hạn số cổ phần.

**Severity basis:** Low theo mục 4 của mẫu: phạm vi hẹp và điều kiện kích hoạt ít khả năng xảy ra. Quy tắc nâng phân loại qua nhiều lượt không cho bỏ vấn đề chỉ vì lịch sử tổn thất nghiêm trọng.

**Exploit Path**

1. Người vay hoàn tất chín chu kỳ tổn thất và tái cấp vốn bằng khoản vay từ factory thật. Vốn mồi ở địa chỉ chết và backstop vẫn giữ lại.
2. Lượng cổ phần trở thành 103019296356454950081780425431896511341288806181963447721196296385035 trong khi tài sản hạch toán về zero.
3. Người dùng gọi mint(1). Kiểm tra đầu vào kế thừa chuyển toàn bộ hạn mức còn lại trước và bị tràn số.

**Prerequisites**

Lịch sử tổn thất cực hạn nhưng đạt tới được theo mã; các rig đủ điều kiện và suy giảm được giả lập. Kiểm thử không gán tùy ý storage cổ phần.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_repeatedLossMaxMintOverflowWithoutBackstopExit()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/critic/AccountingCritic.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).
- [test_R1_repeatedLossMaxMintOverflowWithoutBackstopExit()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Bão hòa phép chuyển cổ phần tối đa khi kết quả toán học vượt uint256, nhưng giữ kiểm tra chuyển đổi chính xác cho lượng mint yêu cầu. Chủ dự án chấp nhận hành vi hiện tại có phạm vi hẹp; chưa tạo bản vá.

**Resolution**

Câu trả lời chung của chủ dự án: Acknowledged vì phạm vi hẹp và lịch sử tổn thất ít khả năng xảy ra nêu trong dòng này; đường deposit hoặc withdraw thay thế vẫn dùng được.

#### [L-02] Chuyển tài sản nhàn rỗi bị tràn trước khi chặn theo số dư người giữ

**Merge key:** `TapePool.maxRedeem:eager-liquidity-conversion-overflow`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** pool-books. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapePool.sol:279](../../src/TapePool.sol). Căn cứ nguồn: pool-books/FINDINGS.md C3-1; CRITIC-3 C3-1; LEDGER C07/P02.

**Summary**

Pool tính lượng cổ phần tương ứng toàn bộ BEM nhàn rỗi trước khi chặn maxRedeem theo số dư người giữ. Lượng cổ phần lớn khiến giá trị trung gian tràn số. Redeem thất bại dù vẫn rút được lượng tài sản nhỏ hơn.

**Impact**

Trạng thái thử nghiệm có khoảng 5.151e75 cổ phần, 1.00000001 BEM tài sản hạch toán và 31.00000001 BEM nhàn rỗi. Redeem và cả view tối đa của người giữ số dư zero đều revert; rút 1 BEM thành công. Lỗi còn sau một giờ và hết tại mốc một ngày được kiểm thử khi thu nhập được giải phóng. Hạn mức tài sản cứng không giới hạn lượng cổ phần.

**Severity basis:** Low theo mục 4 của mẫu: lỗi một phần đường thoát dưới lịch sử ít khả năng xảy ra. Cùng mẫu số học và nhiều lượt hỗ trợ nâng phân loại.

**Exploit Path**

1. Người dùng đạt lịch sử tổn thất nói trên rồi gửi thật 1 BEM.
2. Một người gọi tặng 30 BEM và sync pool.
3. Người giữ gọi redeem. maxRedeem tràn khi chuyển tài sản nhàn rỗi trước khi áp dụng giới hạn hữu hạn của người giữ.

**Prerequisites**

Lịch sử tổn thất dẫn đến lượng cổ phần lớn cùng thu nhập chưa giải phóng. Tặng và sync không cần vai trò đặc quyền.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_R3_largeSupplyIncomeBlocksRedeemButNotWithdraw()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

So sánh quyền đòi tài sản của người giữ với tài sản nhàn rỗi trước khi chuyển toàn bộ phần nhàn rỗi, hoặc bão hòa giá trị tối đa trung gian. Giữ quy tắc làm tròn có lợi cho vault. Chủ dự án chấp nhận hành vi hiện tại.

**Resolution**

Câu trả lời chung của chủ dự án: Acknowledged vì phạm vi hẹp và lịch sử tổn thất ít khả năng xảy ra nêu trong dòng này; đường deposit hoặc withdraw thay thế vẫn dùng được.

#### [L-03] Hạn mức lớn của bản thay thế tràn trước giới hạn pool

**Merge key:** `TapeLens.principalFor:unbounded-debt-inversion`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** lens-factory, system. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapeLens.sol:96](../../src/TapeLens.sol). Căn cứ nguồn: lens-factory LF-01; system L-03/CL-01.

**Summary**

Lens chuyển hạn mức nợ của policy thành gốc trước khi chặn kết quả theo dư địa pool. Bản thay thế hợp lệ có thể trả hạn mức đủ lớn gây tràn. Báo giá tối đa khi đó lỗi dù báo giá chính xác và vay vẫn hoạt động.

**Impact**

Kiểm thử vay 4 BEM sau khi báo giá tối đa panic. Cả hạn mức nợ vô hạn và floor(uint256.max / 10000) + 1 đều gây lỗi số học. Trần gốc cứng thực tế vẫn là 500 BEM. Không lần chuyển tài sản nào phụ thuộc view tối đa bị lỗi này.

**Severity basis:** Low theo mục 4 của mẫu: lỗi view với phạm vi hẹp.

**Exploit Path**

1. Chủ dự án cài bản thay thế có version cao hơn qua hàng đợi bảy ngày thực tế.
2. Người dùng hỏi báo giá tối đa. Lens cộng phí hoặc nhân hạn mức với 10,000 trước khi áp dụng dư địa pool.
3. View revert, trong khi báo giá chính xác biểu diễn được và khoản vay tương ứng thành công.

**Prerequisites**

Bản thay thế bất thường có hạn mức nợ rất lớn. Chủ dự án hiện giới hạn miền hỗ trợ ở các bản thay thế đã được rà soát.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_boundaryFiniteReplacementOverflowsMultiplicationBeforePoolRoom()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/BoundaryReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).
- [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/BoundaryReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Giới hạn phép đảo từ nợ theo dư địa pool thực thi được trước khi số học có thể tràn, hoặc dùng phép đảo bão hòa có kiểm tra. Rà soát hạn mức policy thay thế trước kích hoạt theo yêu cầu chủ dự án.

**Resolution**

Q5 của chủ dự án: Acknowledged. Đầu vào được hỗ trợ dùng policy v1 và factory của chính pool. Mỗi bản thay thế được rà soát riêng trước khi xếp hàng đợi. Lens là view, app dùng factory của chính pool, và không lần chuyển nào phụ thuộc câu trả lời của lens. Những cách vận hành app/rà soát đó do chủ dự án xác nhận, không phải mã bị lược đã được xác minh. Mục 16 của SPEC sẽ được thêm một dòng.

#### [L-04] Policy có khoảng trống che khuất khoản vay nhỏ thực thi được

**Merge key:** `TapeLens._size:gapped-policy-maximum`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** lens-factory. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapeLens.sol:142](../../src/TapeLens.sol). Căn cứ nguồn: lens-factory LF-02, CR-C01; LEDGER R225.

**Summary**

Lens chỉ kiểm tra nợ suy ra từ mức tối đa của policy và dư địa pool. Bản thay thế có thể cho phép nợ nhỏ hơn nhưng từ chối điểm nợ đã chọn. Lens báo không có khoản vay dù khoản nhỏ hơn vẫn thực hiện được.

**Impact**

Với dư địa pool 4 BEM, policy thử nghiệm cho phép nợ đến 2 BEM hoặc đúng 10 BEM. Lens trả DENIED và zero. Gốc thực thi được là 1.99501246 BEM cho bảy ngày hoặc 1.99004975 BEM cho mười bốn ngày. Theo giới hạn cứng, báo giá sai có thể che khuất tối đa 500 BEM gốc, nhưng không vượt hạn mức nào.

**Severity basis:** Low theo mục 4 của mẫu: view báo sai tín dụng thực thi được.

**Exploit Path**

1. Chủ dự án xếp hàng và kích hoạt bản thay thế trả lời trung thực, có khoảng trống trong miền nợ cho phép.
2. Người dùng yêu cầu báo giá tối đa khi dư địa nằm trong khoảng trống đó.
3. Lens kiểm tra một điểm bị từ chối rồi trả zero; vay chính xác một lượng nhỏ hơn thành công.

**Prerequisites**

Bản thay thế bất thường không có tính đóng xuống của miền nợ cho phép. Interface không yêu cầu thuộc tính đó.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_round1TieredPolicyMissesExecutableMaximum()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).
- [test_redoTieredBothTermsAndBothFactoriesCreate()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/RecheckReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Đặc tả và kiểm tra tính đơn điệu của miền nợ ở các bản thay thế được hỗ trợ, hoặc cung cấp truy vấn tối đa có giới hạn xét nợ thực thi được và làm tròn phí. Chỉ thêm đối số trần chưa chắc xử lý được các điểm nợ không đạt tới được.

**Resolution**

Q5 của chủ dự án: Acknowledged. Đầu vào được hỗ trợ dùng policy v1 và factory của chính pool. Mỗi bản thay thế được rà soát riêng trước khi xếp hàng đợi. Lens là view, app dùng factory của chính pool, và không lần chuyển nào phụ thuộc câu trả lời của lens. Những cách vận hành app/rà soát đó do chủ dự án xác nhận, không phải mã bị lược đã được xác minh. Mục 16 của SPEC sẽ được thêm một dòng.

#### [L-05] Cổng kiểm tra chấp nhận runtime reporter không tương thích

**Merge key:** `CheckStack.checkReporter:reporter-build-not-attested`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** deploy. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [script/deploy/CheckStack.s.sol:111](../../script/deploy/CheckStack.s.sol). Căn cứ nguồn: deploy F02/C1/L1; CRITIC-1/3/4; CheckStack.s.sol:123–137.

**Summary**

Cổng kiểm tra xét mẫu đã chuẩn hóa cục bộ rồi yêu cầu reporter báo giá cho mẫu đó. Mẫu không phân biệt được build reporter không tương thích. Toàn bộ cổng kiểm tra đạt với build đó trong fixture fork tái hiện.

**Impact**

Runtime không tương thích báo base 384 H thay vì 24 H cho mẫu multiplier sáu, gấp mười sáu lần. Phát hiện Low nói về kết quả bảo đảm triển khai sai. Chưa xác lập vay thật hoặc tổn thất người cho vay từ runtime đó. Mở rộng trace như vậy cần tài sản thế chấp qua screen, giao nhận, khoản vay được chấp thuận và tổn thất; gốc vẫn bị giới hạn bởi 500 BEM và các kiểm tra cấp vay.

**Severity basis:** Low theo mục 4 của mẫu: thiệt hại bảo đảm có giới hạn. Nhiều lượt và tái hiện toàn bộ cổng kiểm tra đạt hỗ trợ Confidence 100.

**Exploit Path**

1. Kiểm thử đặt runtime không tương thích đã lưu tại địa chỉ reporter mới, với các giá trị ghim đã khóa còn lại hợp lệ.
2. Cổng kiểm tra chỉ đọc thông thường đạt với mẫu multiplier một.
3. Mẫu multiplier sáu có weight 456, bonus thô 72 và bstar 4 bộc lộ câu trả lời 384 H không tương thích.

**Prerequisites**

Vô tình dùng triển khai không tương thích. Kiểm thử toàn bộ cổng thực thi runtime thật và chỉ giả lập ánh xạ vault của mẫu dùng để phân biệt. Đây là lỗi bảo đảm, không phải tấn công tài sản không đặc quyền đã được chứng minh.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_round1_C1_oldRuntimePassesGateButIndependentBuildCheckRejects()](2026-11-05-redeploy-4-prescan/runs/tests/deploy/review/Round1Gate.t.sol); [tests-gates-retry.txt](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Yêu cầu runtime khớp build đã đóng băng. Chủ dự án cho biết runbook bên ngoài đã làm việc này trên cả hai chuỗi, che immutables và giữ metadata. Phiên này không đọc runbook đó hoặc xác minh việc thực hiện.

**Resolution**

Q7 của chủ dự án: Acknowledged vì runbook bên ngoài so sánh mọi runtime mới với build đóng băng trên cả hai chuỗi, che immutables và giữ metadata. Runbook và việc thực hiện nằm ngoài bản xuất, chưa được xác minh.

#### [L-06] Chia nhỏ thanh toán chuyển bụi dự trữ sang thu nhập người cho vay

**Merge key:** `TapePool.repay:fragmented-reserve-rounding`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** pool-loans. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapePool.sol:371](../../src/TapePool.sol). Căn cứ nguồn: pool-loans/CRITIC-3.md CR3-03; TapePool.sol:371–377.

**Summary**

Pool làm tròn xuống phần dự trữ riêng cho từng lần trả phí. Người trả có thể chia phí thành khoản nhỏ, mỗi khoản phân bổ dự trữ bằng zero. Cùng lượng phí khi đó chuyển nhiều BEM hơn sang thu nhập người cho vay.

**Impact**

Một lần trả 500 đơn vị BEM thô phân bổ 100 đơn vị thô vào dự trữ. Qua 125 lần trả bốn đơn vị thô, dự trữ nhận zero và thu nhập nhận cả 500. Nợ và tổng tài sản bảo chứng không đổi. Với tỷ lệ dự trữ cứng 50%, khoản vay 500 BEM có phí ban đầu 30 BEM sẽ có phân bổ dự trữ danh nghĩa tối đa 15 BEM. Chuyển hết phần đó bằng thanh toán một đơn vị cần ba tỷ lần trả. Chưa xác lập rút giá trị đáng kể sau chi phí gas. Phí trễ tối đa cộng 1.5 BEM mỗi ngày trên gốc 500 BEM, không có trần tổng suốt vòng đời.

**Severity basis:** Low theo mục 4 của mẫu: làm tròn bụi có tác động phân bổ tích lũy, không phải miễn nợ.

**Exploit Path**

1. Người trả chia phí thành các khoản rất nhỏ được chấp nhận.
2. Mỗi khoản làm tròn xuống phần dự trữ.
3. Người cho vay nhận thu nhập bị chuyển sang; người trả đồng thời giữ cổ phần nhận phần của mình.

**Prerequisites**

Trả nợ chia nhỏ và tỷ lệ dự trữ đã lưu lớn hơn zero. Người trả cần cổ phần để tự thu lại phần thu nhập bị chuyển.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_critic3FragmentedFeeConservesValueWithoutForgivingDebt()](2026-11-05-redeploy-4-prescan/runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Chủ dự án chấp nhận làm tròn xuống từng khoản là bụi và yêu cầu thêm dòng mới vào mục 16 SPEC. Không yêu cầu đổi mã. Quy tắc phân bổ gộp cần một thiết kế được chấp nhận khác.

**Resolution**

Q4 của chủ dự án: Acknowledged. Chấp nhận làm tròn xuống từng khoản là bụi; cũng chấp nhận tác động thứ tự giữa các khoản vay do hạn mức đã lưu. Mục 16 SPEC sẽ thêm các dòng riêng. Tác động thứ hai vẫn là rủi ro được chấp nhận, không phải phát hiện có chấm mức khác.

#### [L-07] Lens báo giá cho clone mà pool từ chối

**Merge key:** `TapeLens._blocker:foreign-factory-quote`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** lens-factory. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapeLens.sol:160](../../src/TapeLens.sol). Căn cứ nguồn: lens-factory C-03; CRITIC-3 C3-C01.

**Summary**

Lens tin các trường pool và borrower của agent mà không kiểm tra registry factory của pool. Clone thật từ factory khác vượt qua kiểm tra báo giá. Pool từ chối khoản vay của nó bằng NotAgent.

**Impact**

Clone từ factory khác trong tái hiện nhận báo giá được phép 1 BEM và báo giá tối đa 2.64075498 hoặc 4 BEM. Cả hai khoản vay thật đều revert và hoàn tác. Báo giá có thể quảng bá đến dư địa cứng 500 BEM nhưng không thể chuyển số tiền đó. Chưa xác lập app bị lược có cho phép đầu vào này không.

**Severity basis:** Low theo mục 4 của mẫu: view báo sai mà không mất tài sản. Áp dụng nâng phân loại qua nhiều lượt.

**Exploit Path**

1. Bất kỳ người gọi nào triển khai factory thật với cùng tài sản và pool hiện có.
2. Clone của factory đó sở hữu tài sản thế chấp hợp lệ và yêu cầu báo giá.
3. Lens cho phép báo giá; pool.lend từ chối clone vì nó không nằm trong registry factory chính thức.

**Prerequisites**

Agent đầu vào từ factory khác. Chủ dự án cho biết app chỉ dùng factory của chính pool.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_critic3ForeignFactoryQuoteHasNoPoolAuthority()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/critic/Critic3Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Xác thực agent với factory của pool trước khi trả báo giá thực thi được, hoặc buộc bên gọi tuân theo miền đầu vào được hỗ trợ. Chủ dự án chấp nhận miền đầu vào thứ hai; app bị lược chưa được xác minh.

**Resolution**

Q5 của chủ dự án: Acknowledged. Đầu vào được hỗ trợ dùng policy v1 và factory của chính pool. Mỗi bản thay thế được rà soát riêng trước khi xếp hàng đợi. Lens là view, app dùng factory của chính pool, và không lần chuyển nào phụ thuộc câu trả lời của lens. Những cách vận hành app/rà soát đó do chủ dự án xác nhận, không phải mã bị lược đã được xác minh. Mục 16 của SPEC sẽ được thêm một dòng.

#### [L-08] Evaluator bất đồng một phần che khuất nợ được phép

**Merge key:** `CreditPolicy.maxDebt:partial-evaluator-maximum`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** policy. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/CreditPolicy.sol:116](../../src/CreditPolicy.sol). Căn cứ nguồn: policy/LEDGER.md A19; CRITIC-1/3 partial evaluator.

**Summary**

Policy kiểm tra bucket biên khi tính maxDebt. Bất đồng tại đó khiến kết quả bằng zero. Evaluator và bản đối chiếu vẫn có thể đồng ý ở mức nợ thấp hơn mà check cho phép.

**Impact**

Kiểm thử trả mức tối đa zero trong khi check cho phép nợ 1,100,000 đơn vị BEM thô. Điều này không cấp vượt khoản vay. Evaluator v1 đang hoạt động khớp cả 4,096 vector đã thử; fixture bất đồng mô hình hóa evaluator đã đổi hoặc bị lỗi. Giới hạn gốc cứng 500 BEM vẫn giữ nguyên.

**Severity basis:** Low theo mục 4 của mẫu: view bảo thủ báo sai trong điều kiện hạn chế. Nhiều lượt nâng phân loại khu vực này.

**Exploit Path**

1. Evaluator đã đổi bất đồng với bản đối chiếu tại bucket tối đa nhưng khớp ở bucket thấp hơn.
2. Người dùng hỏi maxDebt và nhận zero.
3. Nợ thấp hơn vượt check dù mức tối đa là zero.

**Prerequisites**

Bất đồng một phần sau thay đổi hoặc lỗi evaluator bên ngoài. Chưa chứng minh bất đồng hiện tại trên hệ thống đang hoạt động.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [testReview_maxDebtConservativeAfterPartialEvaluatorDisagreement()](2026-11-05-redeploy-4-prescan/runs/tests/policy/review/PolicyReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Đặc tả zero nghĩa là không có nợ thực thi được hay chỉ thất bại tại biên ưu tiên. Rà soát evaluator đã đổi trước khi dùng báo giá tối đa của chúng. Chủ dự án chấp nhận miền hỗ trợ hạn chế.

**Resolution**

Q5 của chủ dự án: Acknowledged. Đầu vào được hỗ trợ dùng policy v1 và factory của chính pool. Mỗi bản thay thế được rà soát riêng trước khi xếp hàng đợi. Lens là view, app dùng factory của chính pool, và không lần chuyển nào phụ thuộc câu trả lời của lens. Những cách vận hành app/rà soát đó do chủ dự án xác nhận, không phải mã bị lược đã được xác minh. Mục 16 của SPEC sẽ được thêm một dòng.

#### [L-09] Câu trả lời sai định dạng của bản thay thế thoát catch của lens

**Merge key:** `TapeLens._decision:malformed-replacement-abi`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 75

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** lens-factory. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [src/TapeLens.sol:67](../../src/TapeLens.sol). Căn cứ nguồn: lens-factory C-02/N04; CRITIC-1/2/3.

**Summary**

Lens bắt lỗi gọi bên ngoài nhưng không bắt được mọi lỗi giải mã ABI ở phía gọi. Bản thay thế có thể trả thành công dữ liệu sai định dạng và khiến báo giá revert. Rà soát chưa xác lập một triển khai cài đặt bình thường có hành vi đó.

**Impact**

Fixture chứng minh view không dùng được và câu trả lời tối đa không nhất quán với policy sai định dạng. Không có chuyển token. Gốc được báo giá bị chặn bởi dư địa cứng 500 BEM. Policy v1 hiện tại không trả các câu trả lời sai định dạng này.

**Severity basis:** Low theo mục 4 của mẫu, Confidence 75 theo quy tắc nâng phân loại khu vực bị hạ qua nhiều lượt tại mục 5. Trace triển khai bình thường vẫn chưa hoàn tất.

**Exploit Path**

1. Policy giả định có version cao hơn trả lời chuẩn cho phép dò khi kích hoạt.
2. Sau đó nó trả thành công dữ liệu sai định dạng cho truy vấn báo giá.
3. Giải mã ở phía gọi revert ngoài try/catch. Fixture đạt hành vi cục bộ này; chưa chứng minh policy cài đặt bình thường có hành vi đó.

**Prerequisites**

Bản thay thế bất thường có hành vi ABI khi chạy không nhất quán. Việc nâng phân loại qua nhiều lượt được nêu rõ; không khẳng định đây là khai thác hiện tại trên hệ thống thật.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_completionInvalidPolicyAndFeedABIExplicitBoundary()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/CompletionReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation omitted:** mục 5 của mẫu cấm khuyến nghị suy đoán khi trace bên ngoài được nâng phân loại vẫn chưa hoàn tất.

**Resolution**

Q5 của chủ dự án: Acknowledged. Đầu vào được hỗ trợ dùng policy v1 và factory của chính pool. Mỗi bản thay thế được rà soát riêng trước khi xếp hàng đợi. Lens là view, app dùng factory của chính pool, và không lần chuyển nào phụ thuộc câu trả lời của lens. Những cách vận hành app/rà soát đó do chủ dự án xác nhận, không phải mã bị lược đã được xác minh. Mục 16 của SPEC sẽ được thêm một dòng.


### Below threshold

Không có. Không có phát hiện nào có Confidence dưới 75.

### Invalid sau câu trả lời của chủ dự án

#### [I-01] Đặc tả bỏ sót khoảng đệm ngừng cho vay có chủ đích

**Merge key:** `DeployPool.emissionEnd:early-halving-cutoff`

**Severity:** Low (phân loại trước đây; không tính vào số hợp lệ) · **Status:** Invalid · **Confidence:** 100

**Seen in:** Ít nhất 2 lượt thực thi công cụ: kiểm thử đặc tả hành vi được cung cấp từ người rà soát/phản biện và lần phân loại này. Không có k/N chính xác từ các bản ghi tổng hợp. **Units:** policy, feed, lens-factory, deploy, system. **Confirmed by:** AI phân loại qua việc lần theo mã nguồn và kiểm thử được viện dẫn. Chủ dự án phê duyệt cách xử lý; không ghi nhận con người chạy lại đường khai thác.

**Location:** [script/deploy/DeployPool.s.sol:59](../../script/deploy/DeployPool.s.sol). Căn cứ nguồn: policy L-01; feed L-01; lens-factory LF-03; deploy F01; system L-02.

**Summary**

Triển khai đặt mốc ngừng cho vay trước lần halving đầu tiên ba mươi ngày. Đặc tả trong bản xuất gọi mốc đó là lần halving đầu tiên. Chủ dự án xác nhận mốc sớm hơn là có chủ đích.

**Impact**

Thời điểm cấu hình là 1910726132; phép tính lần halving đầu tiên từ quan sát cho 1913318132, lệch 2,592,000 giây. Đây là khoảng đệm đã được phê duyệt. Giữ mức Low lịch sử để truy vết và loại khỏi tổng phát hiện hiện tại.

**Severity basis:** Invalid đối với mã sau Q3 của chủ dự án. Nguyên nhân là câu chữ đặc tả. Chủ dự án xác nhận quyết định ngày 2026-10-19 bị lược; không lấy về tài liệu bị lược nào.

**Exploit Path**

1. Người vay yêu cầu kỳ hạn chạm mốc ngừng sớm đã cấu hình.
2. Policy từ chối đúng thiết kế.
3. Câu chữ trong bản xuất khiến việc từ chối có chủ đích trông như vi phạm yêu cầu mốc ngừng cho vay.

**Prerequisites**

Một thời điểm đáo hạn tương lai gần mốc ngừng đã cấu hình.

**Proof**

Các kiểm thử đạt sau đây đặc tả hành vi; chúng không kiểm chứng hành vi đã sửa. Brief không yêu cầu kiểm thử hồi quy lỗi cho phát hiện Low.

- [test_round3NormativePinActualBorrowAndInclusiveHalvingBoundary()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/Round3Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).
- [testReview_configuredHalvingMarginDeniesThirtyDaysEarly()](2026-11-05-redeploy-4-prescan/runs/tests/policy/review/PolicyReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (đặc tả hành vi/đối chứng: PASS).

**Recommendation**

Sửa mục 2 SPEC thành lần halving đầu tiên trừ 30 ngày. Bản work vẫn đóng băng.

**Resolution**

Q3 của chủ dự án: khoảng đệm lần halving đầu tiên trừ 30 ngày là có chủ đích. Chủ dự án xác nhận đã phê duyệt ngày 2026-10-19 trong quyết định O3 bị lược. Nguyên nhân là câu chữ mục 2 SPEC, không phải lỗi mã. Không lấy về hoặc xác minh độc lập tài liệu bị lược đó.


## Đầu mối

- **CreditPolicy._rig:refbench-external-semantics**. Người rà soát cần miner RefBench thật đã đăng ký, đang hoạt động, có base power, được giữ đúng nơi và có screen pass khớp. Trace đầy đủ về đăng ký bắt buộc và cấp quyền multiplier mặc định cũng có thể giải quyết khoảng trống. Các lần đọc hiện tại cho multiplier zero và không có miner trong những tập kiểm kê hữu hạn. Giả lập không xác lập được khả năng đào. Kiểm thử bên tạo dữ liệu thu hẹp trường hợp status-zero và miner dừng. Chúng không bao phủ mọi verifier, trạng thái hoặc đường cấp quyền Safe. Chưa xác lập đường tín dụng không được chặn, nên nhắc lại nhiều lần không đáp ứng quy tắc nâng phân loại mục 5. Mức phơi nhiễm gốc có điều kiện không vượt tổng 500 BEM hoặc 90% tài sản khi cấp vay. Backstop và hạn mức từng người vay giới hạn thêm. Từ chối sai sẽ che khuất tín dụng đủ điều kiện. Chủ dự án: không rig RefBench nào nhận screen pass trước khi diễn tập đạt. Đầu mối vẫn chưa chấm mức. Nguồn: policy L-03; agent-loan L-01; bằng chứng ngoài giới hạn.

- **RigAgent._voucherRecord:inactive-bridged-harvest**. Người rà soát cần harvest thực tế khi không hoạt động hoặc bị thu hồi qua vault và endpoint nguồn. Trace phải kiểm tra power và khoản chi chờ, rồi tiếp tục qua endpoint, OFT và voucher đích thật. Kiểm thử Round1Producer của agent-loan bao phủ trạng thái công khai dừng và power zero. Chúng không giải quyết mọi chuyển trạng thái thu hồi hoặc nhận định mất quyền hưởng. Chưa xác lập đường khai thác. Bằng chứng khỏe dương sai có thể khôi phục tối đa 500 BEM gốc đang vay. Bằng chứng power zero sai có thể cho phép seize tối đa 16 voucher thế chấp mỗi agent. Mã không đặt trần tính bằng BEM cho giá trị bên ngoài của chúng. Một số mẫu đích đạt nhưng toàn bộ vòng đời liên quan chưa được xác minh. Chủ dự án: giữ đầu mối. Một số mẫu đích đạt nhưng chưa chứng minh đường nguồn-đích hoàn chỉnh cho trạng thái không hoạt động/thu hồi. Nguồn: agent-evidence V-01/E21; agent-loan L-01/Round1Producer; system D16-06.1.

- **TapePool.decimals:cached-asset-metadata-failure**. Người rà soát cần lỗi ở mức EVM hoặc câu trả lời decimals thay đổi từ BEM được ghim trong một lần khởi tạo thành công. Trace sau đó phải chỉ ra thiệt hại cho thao tác client. Mất kết nối HTTP không phải lỗi token như vậy. Số decimals lưu đệm là 18 + 6 = 24. Nó tồn tại sau khi đọc token phục hồi. Câu trả lời thành công bằng 250 hoặc 255 khiến getter hiển thị tràn khi cộng offset. Gửi 1,000,000 đơn vị BEM thô vẫn mint 1,000,000,000,000 đơn vị cổ phần thô. Redeem chuyển số cổ phần đó lại thành 1,000,000 đơn vị BEM thô. Chưa chứng minh mất đơn vị thô. Giới hạn cung và vay cứng vẫn là 1,000 BEM và 500 BEM. Cả hai cổng kiểm tra một phần đều thiếu kiểm chứng hiển thị. Rà soát không tuyên bố toàn bộ cổng hai chuỗi đạt với những fixture này. Nhiều lượt đã sửa phát biểu về đọc bên ngoài nhưng chưa xác lập lỗi token đạt tới được trong vận hành bình thường. Vì vậy quy tắc nâng phân loại đường không có chốt chặn của mục 5 không áp dụng. Q7 của chủ dự án: CheckStack sẽ kiểm chứng decimals của share token. Đây là kế hoạch, chưa triển khai hoặc kiểm thử ở đây. Đầu mối vẫn chưa chấm mức. Nguồn: deploy L2/C4-1; Round4Decimals.

- **CheckStack.readTapeOut:inactive-sample-rejects-gate**. Người rà soát cần một lần ra mắt đầy đủ, hợp lệ về mọi mặt khác, với rig 5 thật không hoạt động hoặc có weight zero. Trace phải chứng minh chỉ phép đẳng thức mẫu từ chối lần ra mắt. Phép đó so verifWeight trừ bonus với bstar nhân mult. Reader hiện tại chặn base đúng nhưng phép so của cổng không làm vậy. Tác động có thể là cổng triển khai bị chặn đến khi đổi mẫu hoặc phép kiểm tra. Chưa xác lập mất BEM trực tiếp. Q7 của chủ dự án: mẫu sẽ so base với số nhỏ hơn giữa verifWeight và bstar nhân mult. Phép kiểm tra này là kế hoạch, chưa triển khai hoặc kiểm thử ở đây. Đầu mối vẫn chưa chấm mức. Nguồn: quan sát mẫu không hoạt động của deploy.

## Rủi ro được chấp nhận

27 nguyên nhân gốc này giữ phân loại rủi ro được chấp nhận. Mỗi dòng nêu phần chấp nhận trong mục 16 SPEC được chạm tới và mã có nằm trong phạm vi đó không. Các phát hiện Acknowledged vẫn là phát hiện ở trên và không được đếm lại tại đây. Các thay đổi đặc tả đang chờ là quyết định chủ dự án, không phải chỉnh sửa đã có trong mã kiểm toán.

- **RigAgent._accrue:late-face-value** — SPEC §16: “PO-3, phí trễ 0 khi ra mắt”. Mã nằm trong phạm vi dòng này. Khoản vay chậm không bị coi là suy giảm chỉ vì đáo hạn. Mức phí trễ zero khi ra mắt không bù đắp tổn thất. Khoản vay về sau chụp lại mức phí trễ của chúng. 

- **TapePool.fee:minimum-fee-subsidy** — SPEC §16: “PO-4, `minFee` thấp hơn chi phí một lần harvest”. Mã nằm trong phạm vi dòng này. Mã tuân theo luồng phí đã chấp nhận. Tài trợ và chi tiêu của keeper vẫn là nghĩa vụ ngoài chuỗi chưa được xác minh. 

- **RigReporter.push:unbounded-sponsored-loan-count** — SPEC §16: “Trợ cấp tài trợ”. Mã nằm trong phạm vi dòng này. Báo cáo tái sử dụng và lần push do người vay trả không giới hạn số khoản vay. Không có triển khai keeper để xác minh quota hoặc cảnh báo chi tiêu. 

- **RigAgent.sweep:unharvested-safe-rescue-output** — SPEC §16: “Keeper harvest một lần khi đáo hạn”. Mã nằm trong phạm vi dòng này. Mã tuân theo cơ chế tin cậy Safe. Hạn mức 8 BEM và 4 BEM được trích là hạn mức khi ra mắt. Phơi nhiễm gốc cứng là 500 BEM. Giới hạn đó không chặn giá trị thế chấp hoặc sản lượng đào. Thao tác harvest sớm của keeper chưa được xác minh. 

- **CreditPolicy._rig:screen-error-credit-loss** — SPEC §16: “`MIN_RIG_AGE` 3 ngày, kèm Q16 screen (2026-10-21)”. Mã nằm trong phạm vi dòng này. Kiểm tra tuổi đo thời gian lịch. Lỗi screen có thể làm mất nợ đã cấp. Tổng gốc cứng là 500 BEM. Giới hạn nợ v1 là 85% và 80% sản lượng dự kiến cho hai kỳ hạn. Không có công cụ chứng minh và bằng chứng cho 12 lần thu hồi lịch sử. 

- **TapePool.markDoubtful:deposit-gate-liveness** — SPEC §16: “Cổng gửi tiền (§11.1)”. Mã nằm trong phạm vi dòng này. Đánh dấu đóng giao dịch vào lượng dương đến khi giải quyết. Các rig suy giảm chồng lấn có thể kéo dài việc đóng. Mức tối đa cứng của minAdvance là 1 BEM. Vì vậy ví dụ ra mắt 0.01 BEM không phải giới hạn phổ quát. 

- **RigAgent._verdict:stored-bu-block** — SPEC §16: “Báo cáo suy giảm đang lưu chặn clear (dòng B, redeploy 3)”. Mã nằm trong phạm vi dòng này. Dòng B và U giữ việc chặn, kể cả khi feed tắt và dữ liệu cũ. M-01 ghi riêng việc ghi đè bằng báo cáo khỏe cũ làm mở chốt chặn. 

- **RigAgent._report:dead-versus-unreadable-feed** — SPEC §16: “Feed chết với rig đã gắn cờ và được cứu”. Mã nằm trong phạm vi dòng này. Feed chết nhưng đọc được giữ dòng B và U. Feed revert không để lại ứng viên báo cáo. Rig được cứu đã bị đánh dấu có thể giữ cổng gửi tiền đóng vô thời hạn. 

- **TapePool.maxWithdraw:unmarked-impairment-exit** — SPEC §16: “Nhìn thấy cứu rig trên BSC trước”. Mã nằm trong phạm vi dòng này. Người giữ hiện tại có thể thoát trước cờ, kể cả trong thời gian phanh. Quyền đòi tài sản và vốn nhàn rỗi sẵn có giới hạn lần thoát. Dự trữ không giới hạn tổng tổn thất người cho vay. 

- **RigAgent._impairment:stale-shield-and-brake-loss** — SPEC §16: “Bật lại feed tạm dừng đồng hồ cờ còn hiệu lực”. Mã nằm trong phạm vi dòng này. Khi feed bật, báo cáo cũ nhưng hợp lý theo dòng S có thể che bằng chứng voucher cũ hơn theo dòng VE. Phanh bỏ lớp che đó. Seize có thể tiến hành nếu đã đáp ứng mốc bằng chứng voucher sau thời gian khắc phục. Nhận định riêng về vượt thời gian khắc phục vẫn bị bác bỏ. 

- **TapePool.disableFeed:repeated-live-flag-freeze** — SPEC §16: “Bật lại feed tạm dừng đồng hồ cờ còn hiệu lực”. Mã nằm trong phạm vi dòng này. Phanh lặp lại có thể kéo dài hạn cờ còn hiệu lực và việc đóng gửi tiền. Chúng không kéo dài thời gian khắc phục hoặc hồi sinh cờ đã hết hạn. 

- **RigAgent._verdict:bonus-only-positive-record** — SPEC §16: “Bonus trong bằng chứng khỏe của đường (b)”. Mã nằm trong phạm vi dòng này. Bản ghi voucher dương mới hơn có thể quyết định khỏe khi không rig nào suy giảm. Dòng B và trường hợp hòa ưu tiên suy giảm vẫn chặn clear. Chấp nhận các chu kỳ flag và clear sau đó. Dòng này không miễn trừ việc khôi phục hiệu lực bản ghi cũ trong M-01. 

- **TapePool._book:post-seize-income-sharing** — SPEC §16: “Giải phóng thu nhập sau seize”. Mã nằm trong phạm vi dòng này. Người vào sau chia sẻ thu nhập seize đến sau trong VEST. Người thoát sớm để lại thu nhập chưa giải phóng. H-01 ghi riêng lỗi giới hạn ban đầu và sự chấp nhận đã sửa của chủ dự án. 

- **TapePool.lendLimit:admission-only-backstop** — SPEC §16: “Backstop chờ sau tổn thất”. Mã nằm trong phạm vi dòng này. Quy tắc backstop chi phối cấp vay. Tổn thất và rút tiền có thể giảm bảo chứng sau đó. Giữ vốn mồi, cảnh báo và bổ sung vốn về sau vẫn là khoảng trống vận hành. 

- **RigAgent.flagImpaired:rescued-rig-feed-off** — SPEC §16: “Rig được cứu khi feed tắt”. Mã nằm trong phạm vi dòng này. Phanh vô hiệu bằng chứng báo cáo theo dòng E. Rig được cứu không thể harvest bằng chứng voucher theo dòng VE. Chủ dự án xem xét nguyên nhân và bật lại feed khi dữ liệu reporter đáng tin. Sau đó keeper gắn cờ rig bằng báo cáo mới. Dòng B và U vẫn chặn clear. 

- **RigFeedReceiver._lzReceive:verification-gap-lock** — SPEC §16: “Tính sống của feed sau `lock` (Phase 3 phần A, 2026-10-19)”. Mã nằm trong phạm vi dòng này. Giao nhận không theo thứ tự ở tầng ứng dụng không vượt yêu cầu xác minh liên tục của endpoint. Địa chỉ owner và delegate bằng zero ngăn bỏ qua khoảng trống xác minh. Lần xác minh lại toàn bộ fork vẫn bị chặn trong lần chạy của người viết. 

- **RigScreen.suspendPass:future-pass-presuspension** — SPEC §16: “Guardian đình chỉ trước (Phase 3 phần A, 2026-10-19)”. Mã nằm trong phạm vi dòng này. Guardian có thể đình chỉ trước một id. Chỉ owner có thể gỡ đình chỉ hoặc đổi guardian. Các hành động này không chuyển tài sản và không đổi khoản vay đang mở. 

- **RigAgent._voucherRecord:future-record-becomes-evidence** — SPEC §16: “Bản ghi voucher có ngày tương lai (redeploy 3)”. Mã nằm trong phạm vi dòng này. Bản ghi từ nâng cấp Safe được phép dùng khi nằm trong 60 giây so với timestamp của nó. Mốc sau thời gian khắc phục vẫn áp dụng. Dòng này không hứa kiểm tra độ mới bổ sung. 

- **RigAgent.forwardVouchers:safe-returned-unlisted-voucher** — SPEC §16: “Voucher bị seize được Safe trả lại (redeploy 3)”. Mã nằm trong phạm vi dòng này. Id bị seize không trong danh sách được trả lại agent đã đóng vẫn không cho người vay rút. Chỉ Safe bên ngoài có thể thu hồi nó. 

- **TapePool.activatePolicy:arbitrary-policy-within-caps** — SPEC §16: “Đổi policy có thể duyệt vay đến các hạn mức (§9.2, quyết định chủ dự án ngày 2026-11-05)”. Mã nằm trong phạm vi dòng này. Hàng đợi bảy ngày và tạm dừng vay vẫn áp dụng. Kiểm tra sở hữu độc lập, giới hạn cứng 500 BEM và 90%, cùng backstop vẫn giữ nguyên. Trần sản lượng dự kiến v1 không áp dụng cho mọi bản thay thế. 

- **RigFeedReceiver._lzReceive:same-second-first-report** — SPEC §16: “Báo cáo cùng giây (§6, quyết định chủ dự án ngày 2026-11-04)”. Mã nằm trong phạm vi dòng này. Timestamp tăng nghiêm ngặt giữ báo cáo đầu tiên trong một giây. Push ở giây sau có thể sửa nó. Bằng chứng khỏe của báo cáo theo dòng H hết hạn sau 300 giây. 

- **RigAgent.clearExpiredFlag:older-other-rig-missing** — SPEC §16: “Báo cáo cũ hơn mốc trên rig khác (§10.5, quyết định chủ dự án ngày 2026-11-04)”. Mã nằm trong phạm vi dòng này. Báo cáo suy giảm trước mốc trên rig khác được coi là thiếu. Clear có thể khôi phục cả khoản vay. Người giữ có thể thoát trước khi gắn cờ mới trở nên khả thi 60 giây sau clear. 

- **TapePool.lendLimit:self-funded-ratio-exit** — SPEC §16: “Tỷ lệ phần trăm sau khoản gửi tự tài trợ (§11.3, quyết định chủ dự án ngày 2026-11-04)”. Mã nằm trong phạm vi dòng này. Các tỷ lệ chi phối cấp vay. Tại tỷ lệ cứng 90%, phần vượt tối đa là 50 BEM khi gốc và tài sản còn lại đều là 500 BEM. Giới hạn backstop độc lập vẫn áp dụng. 

- **TapePool.repay:stored-reserve-base** — SPEC §16: “Cơ sở dự trữ được lưu tại `lend`”. Mã nằm trong phạm vi dòng này. Gửi tiền trước khoản vay mở rộng cơ sở dự trữ được lưu. Gửi hoặc rút sau đó không đổi cơ sở ấy. Dòng đóng băng không bao phủ phân bổ dự trữ qua khoản trả chia nhỏ; Q4 chủ dự án chấp nhận riêng. 

- **CreditPolicy._rig:duplicate-circuit-after-safe-action** — SPEC §16: “Hai vault id cho một circuit sau `rescueFromCell`”. Mã nằm trong phạm vi dòng này. Mã tuân theo sự phụ thuộc Safe đã nêu. Tính trùng quy mô hoặc redeem dưới một khoản vay có thể xảy ra trước khi phát hiện. Không kiểm toán việc từ chối ngoài chuỗi, giám sát và toàn bộ đường cấp quyền Safe ở đây. 

- **RigAgent._verdict:positive-record-without-custody** — SPEC §16: “Bản ghi voucher dương nghĩa là hoạt động có weight, không phải đang được giữ”. Mã nằm trong phạm vi dòng này. Hành động Safe và bỏ lỡ seize có thể cho bản ghi dương mới hơn xóa cờ. Tái hiện fork liên quan vẫn bị chặn, nên chưa xác nhận độc lập hành vi này trên hệ thống thật. 

- **TapePool.repay:cross-loan-reserve-cap-order** — SPEC §16: “Cơ sở dự trữ được lưu tại `lend`”. Mã nằm trong phạm vi dòng này. Mỗi khoản vay dùng hạn mức đã lưu so với dự trữ toàn cục hiện tại. Các khoản vay thử nghiệm có cơ sở dự trữ 10 BEM và 20 BEM. Mỗi khoản trả phí 3 BEM. Một thứ tự tạo 1 BEM dự trữ; thứ tự ngược tạo 0.6 BEM. Thu nhập người cho vay lệch phần bù 0.4 BEM. Cả hai thứ tự đều không rút dự trữ hiện có. Tác động này riêng với làm tròn từng khoản trả. Q4 chủ dự án xác nhận chấp nhận và yêu cầu dòng riêng trong mục 16. Q4 của chủ dự án: Acknowledged. Chấp nhận làm tròn xuống từng khoản là bụi; cũng chấp nhận tác động thứ tự giữa các khoản vay do hạn mức đã lưu. Mục 16 SPEC sẽ thêm các dòng riêng. Tác động thứ hai vẫn là rủi ro được chấp nhận, không phải phát hiện có chấm mức khác.

## Các mục bị bác bỏ khi phân loại

### Cửa 1

- `TapePool.expiryOf:expired-flag-revival` — Cửa 1: logic đồng hồ tìm kiếm nhị phân giữ cờ đã hết hạn ở trạng thái hết hạn; phanh sau đó không thể đặt lại mốc bằng chứng. Nguồn: pool-admin C-03/C3-K1; agent-evidence C-01; system C-03.
- `RigAgent.forwardVouchers:permissionless-list-reconciliation` — Cửa 1: chỉ agent đã đóng chuyển tiếp thế chấp bị seize tới pool bất biến; không có đích do người gọi chọn hoặc đường giải phóng cho người vay. Nguồn: agent-loan P-RepayEgress; system C-04/C-05.
- `RigAgent._moveCollateral:restore-kept-list-before-callbacks` — Cửa 1: vòng lặp chuyển hoàn tất trước khi khôi phục id giữ lại; hiệu ứng closed/no-loan/empty-list/wasSeized xảy ra trước callback. Nguồn: agent-loan C3-E1/C3-E2; các ứng viên về chuyển tài sản của evidence.
- `RigAgent.withdrawVoucher:seized-voucher-to-borrower` — Cửa 1: kiểm tra wasSeized vĩnh viễn đi trước kiểm tra thành viên. Chuyển tiếp hướng tới pool, và factory.create gắn msg.sender. Bộ hợp đồng này không thể tạo agent có borrower là pool. Nguồn: giả thuyết địa chỉ đích của agent-loan.
- `NetlistBuilder.leConst:out-of-width-constant` — Cửa 1: hằng 32 không vừa năm bit và bị cắt. Các bên gọi trong mã sản xuất chỉ dùng 16 hoặc 17. Cả 4,096 vector v1 đều khớp. Nguồn: policy M-WIDTH; CRITIC-1/3.
- `CreditPolicy._gather:zero-agent-owner-equality` — Cửa 1: agent thật có địa chỉ khác zero và tự xác minh sở hữu voucher trước khi cho vay. Câu trả lời ownerOf phải bằng địa chỉ agent. View giả định với agent zero không thể vay. Nguồn: policy CRITIC-3 C3-01.
- `TapePool.lendLimit:fractional-backstop-round-up` — Cửa 1: chuyển đổi làm tròn xuống, dư địa backstop độc lập và kiểm tra lại cuối tại lend từ chối lượng cao hơn quyền đòi có phần lẻ một đơn vị thô. Nguồn: pool-loans CC-01; pool-admin K1.
- `TapePool._restore:double-release-on-seize` — Cửa 1: khôi phục một phần giảm absorbed một lần; write-off xóa phần còn lại mà không hạch toán lại. Nguồn: pool-loans CR3-01.
- `TapePool._book:release-schedule-postponement` — Cửa 1: absorb giữ mốc kết thúc hiện tại; restore dùng lịch còn lại theo trọng số. Không có trì hoãn thêm như giả thuyết. Nguồn: pool-loans CC-02; các ứng viên restore từ phản biện pool-books.
- `TapePool.repay:zero-assets-resolution-block` — Cửa 1: repay, clear và write-off hoạt động khi tài sản bằng zero; chỉ cho vay mới lượng dương bị từ chối. Nguồn: pool-loans CC-03.
- `TapePool.lend:forwarded-income-reserve-base` — Cửa 1: lend ghi checkpoint tiền mới thành lượng idle và unvested bằng nhau, nên cơ sở dự trữ ròng cùng block không tăng. Nguồn: pool-loans CR3-02.
- `TapePool.maxRedeem:fractional-exit-round-up` — Cửa 1: chuyển thanh khoản hữu hạn thông thường làm tròn xuống cổ phần và tôn trọng idle; lỗi tràn ở miền lớn riêng biệt được giữ ở trên. Nguồn: pool-loans CR3-04; đối chứng làm tròn xuống của pool-books.
- `TapePool._book:zero-duration-release` — Cửa 1: trung bình có trọng số của các thời lượng còn lại dương ít nhất một giây; hạch toán không vest tức thì. Nguồn: giả thuyết giây cuối từ phản biện system.
- `RigAgent._accrue:empty-checkpoint-compounding` — Cửa 1: checkpoint khi gốc không đổi dùng làm tròn lên tích lũy trừ lateBooked, không tính phí làm tròn mới mỗi lần gọi. Nguồn: system CRITIC-4 về checkpoint rỗng lặp lại.
- `RigReporter.options:standalone-length-cast` — Cửa 1: helper options độc lập thu hẹp n trước phép tính gas. Cả quote và push từ chối 17 id. Không packet đã gửi nào vượt giới hạn 16-id. Nguồn: system CQ-02.
- `RigAgent.borrow:cross-agent-native-callback` — Cửa 1: callback phí vận hành chính xác nằm cuối, cả hai bản ghi gốc đã được quyết toán, và agent khác không có khoản vay gửi tiền của chính nó cho người vay của nó. Nguồn: system F5-E.
- `TapeLens._size:donation-checkpoint-quote-drift` — Cửa 1: checkpoint cộng lượng idle và thu nhập unvested bằng nhau, giữ tài sản/dư địa/báo giá tại cùng timestamp; vay theo báo giá thành công. Nguồn: lens-factory C3-C02.
- `RigAgent.loanOf:original-principal-view` — Cửa 1: gốc ban đầu giữ ở 100,000,000 đơn vị BEM thô khi gốc còn lại giảm xuống 50,000,000. Trường trong mã là đúng. Nguồn: lens-factory phản biện E2.
- `TapePool.stats:missing-nonzero-field-evidence` — Cửa 1: fixture khác zero được tăng cường xác nhận sáu trường và thay đổi hạn mức; mã không bỏ sót trường nào. Nguồn: lens-factory phản biện E3.
- `TapeLens._blocker:reason-code-abi` — Cửa 1: kiểm tra số độc lập xác nhận giá trị reason từ 0 đến 16. Kiểm thử trước tái dùng hằng chung nên yếu hơn. Đây không phải lỗi mã. Nguồn: lens-factory phản biện E4.
- `TapePool._write:parameter-field-isolation` — Cửa 1: mỗi khóa trong 14 khóa có giới hạn chỉ ghi trường riêng. Xếp hàng không đổi giá trị tham số đang dùng. Nguồn: pool-admin K4.
- `TapePool.activatePolicy:malformed-answer-rollback` — Cửa 1: Boolean, reason, trường bits không chuẩn hoặc tuple ngắn khiến kích hoạt revert. Hàng đợi, policy, số dư tracked và thu nhập chưa giải phóng giữ nguyên. Nguồn: pool-admin C3-K4.
- `TapePool.cancelPolicy:stale-slot-execution` — Cửa 1: kích hoạt hết hạn revert QueueLapsed; hủy xóa slot và không thể rút ngắn hàng đợi mới. Nguồn: pool-admin C3-K3.
- `TapePool.setGuardian:former-role-authority` — Cửa 1: quyền được đọc động; guardian/owner trước mất quyền, và policy đang xếp hàng chặn unpause theo cả hai thứ tự. Nguồn: pool-admin K3.
- `TapePool.queuePolicy:announced-candidate-eta` — Cửa 1: candidate được index và eta bằng giá trị đã xếp hàng; việc hủy qua lowerCap và các slot hàng đợi độc lập là đúng. Nguồn: pool-admin K5.
- `TapePool._checkpoint:admin-income-double-book` — Cửa 1: thặng dư được ghi đúng một lần, thu nhập khi không có cổ phần vào dự trữ; lệnh lỗi hoàn tác mọi hiệu ứng checkpoint. Nguồn: pool-admin K2.
- `RigAgent._impairment:pre-cure-evidence-after-shield-loss` — Cửa 1: phanh có thể bỏ lớp che dòng S mà không bỏ mốc bằng chứng sau thời gian khắc phục. Mốc đó là impairedAt cộng 72 giờ và 60 giây. Bằng chứng trước mốc một giây vẫn bị từ chối. Nguồn: pool-admin C3-K2.
- `RigAgent.flagImpaired:omitted-late-accrual` — Cửa 1: mã cộng dồn trước thứ tự trả từ tiền sẵn có và làm tròn lên; kiểm thử trước thiếu trường hợp phân biệt, kiểm thử sửa đã đạt. Nguồn: agent-evidence CRITIC-1 L14/P25.
- `RigAgent.seize:omitted-late-accrual` — Cửa 1: mã cộng dồn trước NoDebt và quyết toán tổn thất; kiểm thử có vốn xác nhận gốc còn lại và bù đắp dự trữ. Nguồn: agent-evidence CRITIC-1 L45.
- `TapePool.fee:pending-backlog-waives-fee` — Cửa 1: phí cố định được lưu và trả ngay cả khi sản lượng chờ được cấp tiền trước và trả nợ sớm. Nguồn: feed RC-01.
- `CreditPolicy._rig:missing-processor-alternative` — Cửa 1: cả ba lựa chọn processor bất biến đặt bit đủ điều kiện độc lập; khả năng đào RefBench thực tế vẫn là đầu mối riêng. Nguồn: feed RC-02; lens-factory E1.
- `RigAgent._plusSkew:evidence-floor-wrap` — Cửa 1: các mốc enable/seize/bằng chứng thực tế bão hòa tại uint64.max, kể cả giá trị sentinel không có cờ. Nguồn: feed RC-03.
- `RigAgent.borrow:permissive-policy-ownership-bypass` — Cửa 1: kiểm tra thế chấp không rỗng và quyền sở hữu chạy độc lập với policy thay thế trước lend được factory kiểm soát. Nguồn: feed RC-04; kiểm thử policy bất thường của system.
- `TapePool.lend:feed-off-borrow` — Cửa 1: agent và pool độc lập từ chối vay khi feed tắt. Dư địa pool bằng zero và mã chặn là 5. Bỏ pause không vượt phanh feed. Nguồn: feed RC-05.
- `RigReporter.setPeer:rotation-ignored` — Cửa 1: trước lock, peer khác biệt cuối cùng có hiệu lực; sau lock, cập nhật bị từ chối; receiver xác thực peer hiện tại. Nguồn: feed RC-06 reporter.
- `RigFeedReceiver.setPeer:rotation-ignored` — Cửa 1: receiver dùng peer khác biệt cuối cùng trước lock và từ chối peer cũ không còn quyền. Nguồn: feed RC-06 receiver.
- `RigFeedReceiver.lock:old-library-timeout` — Cửa 1: setReceiveLibrary xóa timeout trước đó khi đối số grace bằng zero. Lock loại delegate. Lần chạy lại có mục tiêu xác nhận xóa timeout và từ chối khôi phục. Nguồn: feed CRITIC-3 C3-03; FeedLock và trace dependency được ghim.
- `BscRigReader.read:ignored-miner-metadata` — Cửa 1: metadata bị bỏ qua không đi vào đầu vào khoản vay. Giải mã có kiểu vẫn từ chối 13 word hẹp sai định dạng. Không chỉ ra trường được dùng nào sai. Nguồn: các ứng viên Miner/Context bị bỏ qua của feed.
- `BscRigReader.read:raw-bonus-normalization` — Cửa 1: reader lấy weight trừ số nhỏ hơn giữa weight và bstar nhân mult để tính bonus. Weight mẫu 456 cho bonus chuẩn hóa 432 và base 24. L-05 ghi riêng kết quả cổng kiểm tra với build không tương thích. Nguồn: đối chứng bonus của feed; phân biệt deploy F02.
- `CheckStack.readTapeOut:expect-call-not-enforced` — Cửa 1: vm.expectCall được thực thi khi forge script kết thúc; return nội bộ trước lỗi đó không phải cổng kiểm tra đạt. Nguồn: giả thuyết expected-call của deploy/GateDryRun.s.sol.
- `CheckStack.checkOnForks:historical-helper-bypass` — Cửa 1: toàn bộ cổng từ chối bốn danh tính feed đã ngừng dùng; checkPool là tập con và entry sản xuất không gọi checkReusedFeed. Nguồn: các ứng viên lịch sử/tập con của deploy.
- `CheckOldStack.run:arbitrary-range-census` — Cửa 1: lần chạy sản xuất ghim bộ thứ ba/block bắt đầu; đầu vào helper tùy ý không nằm trên đường gọi đó. Lần kiểm kê đầy đủ hiện tại không đọc lại được các trang RPC. Nguồn: ứng viên quét factory cũ chưa hoàn tất của deploy.
- `FeedConfig.mirror:setup-order-confirmations` — Cửa 1: các entry triển khai sao khớp và lock trước khi gửi. Gửi trước tạo khác biệt đã kiểm thử giữa 21 và 20 confirmations. Chuỗi đó ngoài các entry này và không xác lập hạ cấp ngầm trên hệ thống thật. Nguồn: ứng viên mirror/send/NIL của deploy.
- `RigReporter.push:batch-read-error-suppression` — Cửa 1: lô có 16 hoặc 15 rig đọc được đều tạo một packet. Lô không có rig đọc được không tạo packet. Lỗi không liên quan truyền ra, và chốt kích thước lô giữ nguyên. Nguồn: ứng viên batching/read-error của deploy.
- `CreditPolicy.constructor:divide-before-multiply` — Cửa 1: NETLIST_RET làm tròn lên độ dài byte thành word ABI 32-byte. Chia trước nhân cung cấp phần đệm cần thiết. Nó không mất độ chính xác kinh tế. Nguồn: src/CreditPolicy.sol:19.
- `TapePool._book:incorrect-equality` — Cửa 1: khoản nhận zero/phần dư zero/cung zero chọn nhánh không làm gì hoặc dự trữ/vesting; thặng dư khác zero không tránh được checkpoint theo số dư. Nguồn: src/TapePool.sol:796.
- `RigAgent.seizeEvidenceFrom:incorrect-equality` — Cửa 1: sentinel cờ zero trả uint64.max; cờ thật dùng mốc sau thời gian khắc phục. Nguồn: src/RigAgent.sol:600.
- `TapePool.lend:incorrect-equality` — Cửa 1: phép bằng so sentinel hoặc enum rõ ràng, không cấp quyền chuyển giá trị. Nguồn: src/TapePool.sol:325.
- `TapePool.stats:incorrect-equality` — Cửa 1: kiểm tra gross bằng zero tránh chia cho zero. Nếu khác zero, utilization lấy gốc đang vay chia tổng tài sản nhàn rỗi và gốc đang vay. Nguồn: src/TapePool.sol:470.
- `TapePool._sync:incorrect-equality` — Cửa 1: thặng dư zero không có gì để ghi. Pool ghi thặng dư dương đúng một lần. Nguồn: src/TapePool.sol:788.
- `RigAgent.seize:incorrect-equality` — Cửa 1: prin bằng gốc còn lại phát hiện nợ đã đủ tiền thanh toán. Agent từ chối seize trường hợp đó; không mở khóa tài sản. Nguồn: src/RigAgent.sol:437.
- `RigAgent.flagEvidenceFrom:incorrect-equality` — Cửa 1: sentinel lần clear/expiry trước bằng zero chọn mốc ban đầu; mốc sau đó gồm skew. Nguồn: src/RigAgent.sol:593.
- `TapePool.unvestedNow:incorrect-equality` — Cửa 1: phần dư/mốc kết thúc zero chọn lịch đã vest hết; phép tính thời gian trôi xử lý thu nhập dương. Nguồn: src/TapePool.sol:783.
- `TapePool.fee:uninitialized-local` — Cửa 1: bps được gán trong cả hai nhánh kỳ hạn hợp lệ; nhánh không hợp lệ revert BadTerm trước khi đọc nó. Nguồn: src/TapePool.sol:294.
- `TapePool._frozenUntil:uninitialized-local` — Cửa 1: lo bắt đầu ở zero làm cận dưới tìm kiếm nhị phân. Không đọc bộ nhớ cũ. Nguồn: src/TapePool.sol:847.
- `RigAgent._verdict:uninitialized-local` — Cửa 1: reported mặc định false đến khi báo cáo đủ điều kiện dòng H, B hoặc U. Biến cục bộ at mặc định zero. Việc dùng nó phụ thuộc reported hoặc điều kiện đoản mạch đã định nghĩa. M-01 nói về ngữ nghĩa bằng chứng không an toàn, không phải storage chưa khởi tạo. Nguồn: src/RigAgent.sol:664.
- `TapePool.expiryOf:uninitialized-local` — Cửa 1: lo mặc định zero làm cận dưới tìm kiếm nhị phân. Nguồn: src/TapePool.sol:861.
- `RigAgent._impairment:uninitialized-local` — Cửa 1: healthyAt mặc định zero, nghĩa là không có lớp che. Bản ghi có ngày được phép dùng chủ đích so với giá trị đó. Nguồn: src/RigAgent.sol:633.
- `RigAgent.seize:uninitialized-local` — Cửa 1: evidence bắt đầu false, được đặt bởi bằng chứng thế chấp đủ điều kiện, nếu không sẽ gây NoEvidence; cơ chế là fail-closed. Nguồn: src/RigAgent.sol:437.
- `TapeLens._decision:unused-return` — Cửa 1: lens dùng allowed/reason/expected từ policy; bỏ các bit chẩn đoán mã hóa không có nghĩa là thiếu chốt khoản vay. Nguồn: src/TapeLens.sol:67.
- `RigAgent.borrow:unused-return` — Cửa 1: borrow dùng allowed và reason, rồi tự kiểm tra sở hữu/kỳ hạn/hạn mức; bit chẩn đoán không dùng và sản lượng dự kiến không còn quyết định sau đổi policy đã chấp nhận. Nguồn: src/RigAgent.sol:276.
- `TapePool._checkPolicy:unused-return` — Cửa 1: phép dò kích hoạt kiểm tra câu trả lời chuẩn có kiểu; bỏ dữ liệu chẩn đoán không vượt kiểm tra mã/version, timelock hoặc chốt khoản vay còn lại. Nguồn: src/TapePool.sol:920.
- `RigFeedReceiver.lock:unused-return` — Cửa 1: receiver ghim thư viện tường minh và xác thực cấu hình sao khớp. Cờ default tham chiếu BEM không cho phép default của receiver thay đổi được. Nguồn: src/feed/RigFeedReceiver.sol:83.
- `PolicyV1.build:unused-return` — Cửa 1: build sửa netlist bằng cách thêm bản ghi đầu ra cuối; chủ đích không cần dùng chỉ số tín hiệu trả về. Nguồn: src/libraries/PolicyV1.sol:29.
- `TapeLens._size:unused-return` — Cửa 1: lượng dư địa giới hạn quy mô; bỏ mã chẩn đoán hạn mức đang ràng buộc trong _size không thể tăng lượng đó. Nguồn: src/TapeLens.sol:142.
- `RigAgent.initialize:missing-zero-check` — Cửa 1: initialize chỉ chấp nhận factory bất biến của nó, có create truyền msg.sender làm borrower; implementation đã đóng. Borrower zero không phải đầu vào factory đạt tới được. Nguồn: src/RigAgent.sol:186.
- `TapeLens.principalFor:calls-loop` — Cửa 1: hàm tính gốc từ hạn mức nợ và tỷ lệ phí rồi kiểm tra phí làm tròn lên. Đầu vào hợp lệ biểu diễn được cần tối đa một chỉnh sửa làm tròn. Tính phí là lệnh pure có giới hạn. L-03 bao phủ riêng lỗi số học với đầu vào lớn. Nguồn: src/TapeLens.sol:96.
- `CreditPolicy._report:calls-loop` — Cửa 1: policy đọc tối đa 16 báo cáo thế chấp từ receiver cố định có kiểu. Đây là tác vụ view có giới hạn, không phải thay đổi trạng thái qua reentrancy. Nguồn: src/CreditPolicy.sol:294.
- `TapeLens._pending:calls-loop` — Cửa 1: tối đa 16 giá trị pending uint128 có tổng nhỏ hơn hai lũy thừa 132. Gọi receiver cố định có kiểu không thể kích hoạt thay đổi trạng thái vô hạn. Nguồn: src/TapeLens.sol:189.
- `RigAgent.borrow:calls-loop` — Cửa 1: agent đọc sở hữu tối đa 16 lần, mỗi lần giới hạn 100,000 gas. Nó xác minh sở hữu trước khi vay, và chốt reentrancy vẫn hoạt động. Nguồn: src/RigAgent.sol:276.
- `RigAgent._report:calls-loop` — Cửa 1: _verdict đọc tối đa 16 báo cáo từ feed cố định. Chưa xác lập vòng lặp người dùng vô hạn hoặc callback có thể thay đổi. Nguồn: src/RigAgent.sol:687.
- `AgentFactory.create:reentrancy-events` — Cửa 1: initialize của clone mới chỉ gắn borrower/index và không tương tác không tin cậy trước AgentCreated. Nguồn: src/AgentFactory.sol:48.
- `RigAgent._fresh:timestamp` — Cửa 1: kiểm thử bao phủ tuổi thọ 300 giây và skew 60 giây có chủ đích, tại dấu bằng và vượt một giây. Không tìm thấy cách vượt bằng đồng hồ khác. Nguồn: src/RigAgent.sol:749.
- `TapeLens._blocker:timestamp` — Cửa 1: thời gian chờ 360 giây sau bật lại feed khớp pool.lend. Báo giá không vượt được kiểm tra cuối của pool. Nguồn: src/TapeLens.sol:160.
- `TapePool._sync:timestamp` — Cửa 1: thời gian chỉ ghi checkpoint thu nhập đã vest; xử lý thặng dư zero không tạo tiền. Nguồn: src/TapePool.sol:788.
- `TapePool._book:timestamp` — Cửa 1: thời lượng giải phóng dương có trọng số không vượt VEST. Làm tròn không giải phóng thu nhập cùng block. Nguồn: src/TapePool.sol:796.
- `TapePool.disableFeed:timestamp` — Cửa 1: khoảng mới ghi thời gian hiện tại một lần; disable lặp bị từ chối và không xóa được lịch sử trước. Nguồn: src/TapePool.sol:545.
- `RigAgent.seize:timestamp` — Cửa 1: thời gian khắc phục kéo dài 72 giờ thực. Expiry hiện tại và các mốc bằng chứng giới hạn seize. Nguồn: src/RigAgent.sol:437.
- `TapePool.stats:timestamp` — Cửa 1: view hàng đợi bao gồm điểm hết hạn bảy ngày sau eta. Nó không cấp quyền thực thi. Nguồn: src/TapePool.sol:470.
- `TapePool._feedSettling:timestamp` — Cửa 1: vay phải chờ 360 giây sau bật feed. Người vay mới không kiểm soát timestamp bật đã ghi. Nguồn: src/TapePool.sol:894.
- `RigAgent._lateSince:timestamp` — Cửa 1: thời gian trễ bắt đầu tại mốc muộn hơn giữa đáo hạn và kỳ cộng dồn cuối; rate/principal đã lưu giới hạn công thức. Nguồn: src/RigAgent.sol:533.
- `TapePool.lend:timestamp` — Cửa 1: thời gian là đồng hồ giao thức có giới hạn được dùng có chủ đích; chưa xác lập cách vượt bằng timestamp do người gọi kiểm soát. Nguồn: src/TapePool.sol:325.
- `RigAgent.flagEvidenceFrom:timestamp` — Cửa 1: mốc bằng chứng dùng clear/old-expiry+skew với phép bão hòa, không dùng thời gian kẻ tấn công cung cấp. Nguồn: src/RigAgent.sol:593.
- `CreditPolicy.constructor:timestamp` — Cửa 1: constructor policy yêu cầu mốc phát hành ở tương lai. Mốc ngừng được phê duyệt là lần halving đầu tiên trừ 30 ngày. I-01 là nhận định Invalid đối với mã trước đây do câu chữ SPEC. Nguồn: src/CreditPolicy.sol:73.
- `RigAgent.seizeEvidenceFrom:timestamp` — Cửa 1: mốc sau thời gian khắc phục gồm skew đồng hồ có chủ đích. Khi không có cờ, hàm trả giá trị uint64 tối đa. Nguồn: src/RigAgent.sol:600.
- `RigFeedReceiver._lzReceive:timestamp` — Cửa 1: báo cáo đã xác thực từ chối skew tương lai quá mức và chỉ timestamp mới hơn hẳn thay storage; rủi ro cùng giây được chấp nhận riêng. Nguồn: src/feed/RigFeedReceiver.sol:59.
- `TapePool.unvestedNow:timestamp` — Cửa 1: hàm trả zero tại hoặc sau vestEnd. Trước đó, suy giảm tuyến tính có giới hạn không chi tiền không có sẵn. Nguồn: src/TapePool.sol:783.
- `RigAgent._expired:timestamp` — Cửa 1: cờ đã hết hạn vẫn hết hạn và cờ còn hiệu lực dùng đồng hồ đóng băng của pool, không dùng timestamp báo cáo. Nguồn: src/RigAgent.sol:588.
- `TapePool.activatePolicy:timestamp` — Cửa 1: chỉ ứng viên đã xếp hàng được kích hoạt trong khoảng eta/grace công khai sau kiểm tra lại mã/version. Nguồn: src/TapePool.sol:666.
- `RigAgent.flagImpaired:timestamp` — Cửa 1: cờ còn hiệu lực hiện có không thể đặt lại thời gian khắc phục; cờ thay thế cần bằng chứng sau mốc expiry/clear trước. Nguồn: src/RigAgent.sol:385.
- `TapePool.policySwapQueued:timestamp` — Cửa 1: view báo hàng đợi còn hiệu lực đến hết điểm cuối grace; hết hạn không cho phép kích hoạt sớm. Nguồn: src/TapePool.sol:465.
- `RigAgent._voucherRecord:timestamp` — Cửa 1: skew bản ghi tương lai được so với now; việc trở nên hợp lệ về sau được chấp nhận rõ trong dòng nâng cấp Safe. Nguồn: src/RigAgent.sol:700.
- `CreditPolicy._gather:timestamp` — Cửa 1: đáo hạn phải trước mốc ngừng đã cấu hình. Kỳ hạn vẫn là bảy hoặc mười bốn ngày. Mốc ngừng được phê duyệt là lần halving đầu tiên trừ 30 ngày. I-01 là nhận định Invalid đối với mã trước đây do câu chữ SPEC. Nguồn: src/CreditPolicy.sol:134.
- `TapePool.queueParam:timestamp` — Cửa 1: kiểm tra quyền và giới hạn cứng đi trước thời gian chờ 48 giờ mới. Người gọi không chọn timestamp. Nguồn: src/TapePool.sol:610.
- `TapePool.executeParam:timestamp` — Cửa 1: thực thi chỉ nhận giá trị đã lưu từ eta đến bảy ngày sau eta, gồm cả hai điểm cuối. Nó kiểm tra lại giới hạn cứng. Nguồn: src/TapePool.sol:626.
- `RigAgent._accrue:timestamp` — Cửa 1: phí trễ đơn dùng rate đã lưu, gốc còn lại và thời gian trôi, trừ lateBooked để tránh tính làm tròn lên lặp lại. Nguồn: src/RigAgent.sol:524.
- `TapePool._lapsePolicyIfStale:timestamp` — Cửa 1: thời gian là đồng hồ giao thức có giới hạn được dùng có chủ đích; chưa xác lập cách vượt bằng timestamp do người gọi kiểm soát. Nguồn: src/TapePool.sol:909.
- `TapePool.maxDeposit:timestamp` — Cửa 1: kiểm tra doubtful và dư địa cung dùng tài sản nhất quán với checkpoint; không chỉ ra cách vượt đầu vào chỉ nhờ thời gian. Nguồn: src/TapePool.sol:262.
- `TapePool.expiryOf:timestamp` — Cửa 1: tìm kiếm nhị phân cộng các khoảng đóng băng, giữ cờ đã hết hạn và bão hòa kết quả uint64. Nguồn: src/TapePool.sol:861.
- `CreditPolicy._rig:timestamp` — Cửa 1: kiểm tra tuổi/độ mới/skew và weight hợp lý là yêu cầu cấp vay có chủ đích. Nguồn: src/CreditPolicy.sol:155.
- `TapePool._sub:timestamp` — Cửa 1: phép trừ bão hòa ngăn underflow khi tính khoảng đồng hồ bị tạm dừng. Nguồn: src/TapePool.sol:880.
- `RigAgent._base:timestamp` — Cửa 1: id báo cáo và cận trên skew được kiểm tra trước khi phân loại vai trò bằng chứng. Nguồn: src/RigAgent.sol:744.
- `RigAgent.hasLoan:timestamp` — Cửa 1: gốc còn lại/phí/phí trễ đã trôi được đánh giá nhất quán; chỉ đáo hạn không đóng khoản vay. Nguồn: src/RigAgent.sol:517.
- `RigAgent._verdict:timestamp` — Cửa 1: timestamp chọn H/B/U/VC đủ điều kiện và suy giảm thắng khi hòa; phát hiện ngữ nghĩa báo cáo bị bỏ được giữ riêng. Nguồn: src/RigAgent.sol:664.
- `RigAgent._impairment:timestamp` — Cửa 1: chỉ E/VE đủ điều kiện kích hoạt flag/seize; lớp che S cũ và mất lớp che khi phanh là rủi ro được chấp nhận rõ. Nguồn: src/RigAgent.sol:633.
- `TapePool._frozenUntil:timestamp` — Cửa 1: tìm kiếm nhị phân dùng các khoảng lưu đơn điệu, không dùng lịch sử do người dùng cấp. Nguồn: src/TapePool.sol:847.
- `TapePool.repay:timestamp` — Cửa 1: thời gian accrual/checkpoint không đổi cơ sở/tỷ lệ/hạn mức dự trữ đã lưu; lượng và hiệu ứng nợ vẫn có chốt bảo vệ. Nguồn: src/TapePool.sol:352.
- `TapePool.writeOff:timestamp` — Cửa 1: write-off chỉ dành cho agent của factory, dùng gốc/dấu đã lưu và mức bù dự trữ theo min; timestamp không cấp quyền người gọi. Nguồn: src/TapePool.sol:410.
- `TapePool.lendLimit:timestamp` — Cửa 1: kiểm tra pause/feed/settle và đổi policy đang xếp hàng đóng cấp vay; lend lặp lại các kiểm tra. Nguồn: src/TapePool.sol:436.
- `RigScreen.isEffective:timestamp` — Cửa 1: kiểm tra đòi tuple khớp chính xác, pass đã chờ đủ 48 giờ và không bị đình chỉ. Nguồn: src/RigScreen.sol:121.
- `BscRigReader._owns:assembly` — Cửa 1: staticcall có giới hạn đòi thành công, ít nhất 32 byte trả về và độ rộng địa chỉ chuẩn trước khi reader dùng thông tin quyền giữ. Nguồn: src/feed/BscRigReader.sol:46.
- `CreditPolicy._voucherMatches:assembly` — Cửa 1: phép đọc có giới hạn sao chép số word giới hạn và xác thực danh tính tuple; câu trả lời ngắn/revert xóa đủ điều kiện. Nguồn: src/CreditPolicy.sol:255.
- `RigAgent._voucherRecord:assembly` — Cửa 1: phép đọc có giới hạn sao chép bốn word, đòi 128 byte và kiểm tra skew tương lai. Bản ghi vẫn unknown nếu các kiểm tra không đạt. Nguồn: src/RigAgent.sol:700.
- `CreditPolicy._eval:assembly` — Cửa 1: staticcall có giới hạn chỉ chấp nhận đầu ra Boolean đúng chuẩn và đòi khớp bản đối chiếu cục bộ. Nguồn: src/CreditPolicy.sol:236.
- `CreditPolicy._pinsOk:assembly` — Cửa 1: đọc giá trị ghim sao chép lượng trả về có giới hạn và so độ dài/giá trị/hash netlist chuẩn; assembly không bỏ các kiểm tra. Nguồn: src/CreditPolicy.sol:197.
- `RigAgent._tryMove:assembly` — Cửa 1: không tin giá trị token trả về là bằng chứng đã chuyển; quyền sở hữu chuẩn sau chuyển quyết định đã chuyển hay giữ lại, có giới hạn gas. Nguồn: src/RigAgent.sol:827.
- `RigAgent._moveCollateral:assembly` — Cửa 1: mảng kết quả chỉ co về độ dài đã đếm. Độ dài đó không vượt độ dài thế chấp đã cấp phát, tối đa 16. Nguồn: src/RigAgent.sol:799.
- `TapeLens._owns:assembly` — Cửa 1: ownerOf là staticcall có giới hạn; kiểm tra thành công/độ dài/địa chỉ chuẩn đi trước phép bằng. Nguồn: src/TapeLens.sol:176.
- `RigAgent._ownerOf:assembly` — Cửa 1: ownerOf đòi thành công/32 byte/khác zero/độ rộng chuẩn; câu trả lời không chuẩn, thiếu hoặc ngắn là unknown. Nguồn: src/RigAgent.sol:728.
- `CreditPolicy._screened:assembly` — Cửa 1: phép đọc screen có giới hạn đòi word true chuẩn, 1. Dữ liệu khác fail-closed. Nguồn: src/CreditPolicy.sol:283.
- `TapePool._withdraw:dead-code` — Cửa 1: withdraw/redeem ERC4626 kế thừa gọi override; nhãn dead-code của Slither bỏ sót điều phối hàm kế thừa. Nguồn: src/TapePool.sol:766.
- `TapePool._deposit:dead-code` — Cửa 1: deposit/mint ERC4626 kế thừa gọi override; hook đạt tới được, không phải mã chết. Nguồn: src/TapePool.sol:759.
- `TapePool.owner:interface-implementation` — Cửa 1: TapePool.owner ghi rõ override Ownable và ITapePool tại dòng mã 315. Kiểm thử triển khai và vai trò thực thi nó. Nguồn: src/interfaces/ITapePool.sol:65.

### Cửa 2

- `TapePool.writeOff:unmarked-agent-impersonation` — Cửa 2: write-off tổng hợp không có dấu giả danh agent; clone thật chỉ tới writeOff qua seize đã gắn cờ và có chốt bảo vệ. Nguồn: đường do kiểm thử tạo bị pool-books bác bỏ; CRITIC-1.
- `RigAgent._forward:short-token-success` — Cửa 2: token tổng hợp không làm gì trả 31 byte và tạm giữ 100 đơn vị BEM thô. BEM chuẩn được ghim không thể trả vậy. Claim sau đó lấy lại số dư fixture. Nguồn: agent-loan R1-TOKEN.
- `CreditPolicy._report:successful-malformed-feed-abi` — Cửa 2: giải mã dữ liệu ngắn ở bên gọi thoát catch. Receiver bất biến có kiểu luôn mã hóa tuple 480-byte của nó. Không có đường bên tạo trả dữ liệu sai định dạng. Nguồn: policy A01/E03/R11.
- `RigAgent._report:successful-malformed-feed-abi` — Cửa 2: cùng ranh giới giải mã giả định, nhưng feed cố định có kiểu không thể trả thành công báo cáo một byte. Nguồn: ranh giới bên dùng feed; RigAgent.sol:694.
- `TapeLens._pending:successful-malformed-feed-abi` — Cửa 2: receiver bất biến có kiểu hiện tại không có đường trả thành công returndata ngắn; thay giả lập không xác lập trạng thái sản xuất thực thi được. Nguồn: thành phần feed của lens-factory C-02/N04.
- `CreditMath.bucket:full-width-numerator` — Cửa 2: phản ví dụ helper cần expected gần uint256.max. Mã sản xuất dùng báo cáo uint64 hợp lý, tối đa 16 rig và kỳ hạn tối đa 14 ngày. Các giới hạn này chặn expected ở 155,929,790,016,000 đơn vị BEM thô. Nguồn: policy C-01/R1-WIDE/C13.
- `TapePool._feedSettling:epoch-and-uint64-horizon` — Cửa 2: 360 giây Unix đầu và giới hạn timestamp uint64 nằm ngoài vòng đời hiện tại của các chuỗi này. Expiry bão hòa không quay vòng. Nguồn: kiểm tra miền của pool-admin CRITIC-3.
- `FeedProbe.setupReceiver:prototype-order-and-owner` — Cửa 2: các hợp đồng spike cũ riêng biệt không phải feed sản xuất; setup lặp có thể làm peer lệch, nhưng CheckFeed sản xuất từ chối owner còn giữ. Nguồn: các ứng viên setup cũ/nguyên mẫu của deploy.
- `FeedProbe.status:prototype-arithmetic` — Cửa 2: panic chẩn đoán raw-bonus/thời gian tương lai của nguyên mẫu không có đường triển khai sản xuất; status sản xuất dùng bão hòa. Nguồn: raw bonus/timestamp tương lai của nguyên mẫu deploy.

### Cửa 3

- `TapePool.executeParam:early-calendar-late-rate` — Cửa 3: owner phải xếp hàng trái cam kết có ngày; khoản vay cũ giữ snapshot và người vay mới giới hạn maxLate. Không chỉ ra tác nhân bên ngoài khuếch đại. Nguồn: pool-loans C-02; pool-admin C-01/4.4.PO3; agent-loan C-02.
- `RigReporter.lock:already-pinned-library` — Cửa 3: setup có quyền có thể bỏ ghim thư viện rồi lock sau SameValue. Chưa xác lập vượt quyền từ bên ngoài hoặc mất mát vĩnh viễn. Lần thử lại phục hồi reporter và receiver có mục tiêu đạt tại BSC block 131934929 và X Layer block 75126506. Các lần lỗi trước vẫn là lỗi lịch sử. Kết quả không xác lập một đợt fork hoàn chỉnh. Xem [lần thử lại có mục tiêu đạt](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) cho test_round1AlreadyPinnedSameLibraryDataRecoveryAndBothOrders(). Nguồn: ứng viên thư viện ghim trước từ phản biện feed.
- `RigFeedReceiver.lock:already-pinned-library` — Cửa 3: cùng vấn đề cấu hình trước lock có thể phục hồi; quyền không bị âm thầm bỏ trước revert. Nguồn: ứng viên thư viện ghim trước từ phản biện feed.

### Cửa 4

- `TapePool._deposit:pull-before-effects` — Cửa 4: bên quan sát thấy supply/tracked cũ trong lúc kéo tiền vào, nhưng thay đổi có chốt bảo vệ bị từ chối và chưa chứng minh hook token thật hoặc cổ phần chưa trả tiền. Nguồn: pool-books C-01/I10/P11; system C-01.
- `TapePool.repay:pull-before-cash-tracking` — Cửa 4: hiệu ứng gốc đi trước kéo tiền; tracked đi sau. BEM được ghim không có hook, nonReentrant và hoàn tác ngăn mất bảo chứng như nhận định. Nguồn: pool-loans C-01/11.2-17/15-10/A8-15.
- `RigAgent.repay:pull-before-debt-effects` — Cửa 4: có thể quan sát nợ agent cũ khi kéo tiền từ người trả, nhưng chưa chứng minh khai thác hook ở token bất biến và không nạn nhân mất tài sản. Nguồn: agent-loan C-01/I10/P-Order; system C-01.
- `TapePool.maxDeposit:zero-entry-during-doubt` — Cửa 4: deposit/mint zero thay đổi zero BEM và zero cổ phần; yêu cầu dương revert. Mâu thuẫn nghĩa đen §15.15 vẫn còn. Nguồn: pool-books C-02/A44/I15; system I15.1.
- `TapePool.maxDeposit:zero-assets-supply-cap-wording` — Cửa 4: tài sản zero vẫn cho tái cấp vốn có trả tiền khi dư địa vay zero; không dẫn tới vượt hạn mức hoặc mint không bảo chứng. Nguồn: pool-books C-03/C05.
- `RigAgent.seize:closed-loan-error-selector` — Cửa 4: khoản vay mở đủ tiền trả về NoDebt, khoản đã xóa trả NoLoan; cả hai cấm seize và không chuyển voucher. Nguồn: agent-evidence C-02/P11; system C-06.
- `RigAgent.withdrawVoucher:unknown-owner-forgets-entry` — Cửa 4: rút chỉ dành cho người vay khi không có khoản vay bỏ mục không đọc được nhưng không chuyển nó nơi khác; register/withdraw lấy lại khi đọc hoạt động. Nguồn: agent-loan CL-01; system F5-D.
- `RigAgent._add:full-list-duplicate-return` — Cửa 4: id đã có trong danh sách có thể trở về danh sách đầy. Danh sách vẫn 16 mục. Không vượt giới hạn khoản vay, hạn mức hoặc sở hữu. Nguồn: agent-loan L-02/10.2-05/10.2-07.
- `RigAgent._accrue:tiny-principal-late-rounding` — Cửa 4: mười kỳ tự nguyện trả thu 40 đơn vị thô, so với 35 khi không giảm gốc. Chỉ người trả chịu thêm bụi. Nợ chưa trả không lãi kép. Nguồn: agent-loan C3-R.
- `CreditPolicy._rig:nominal-emission-dust` — Cửa 4: xấp xỉ phát hành theo ngày tròn lệch 28,512 đơn vị BEM thô mỗi ngày toàn mạng. Sai lệch tương đối khoảng 0.00000004. Chưa chỉ ra tổn thất đáng kể hoặc khuếch đại vượt các biên 85% và 80%. Nguồn: policy L-02; quan sát dependency của lens.
- `TapePool.lendLimit:ratio-excess-equality` — Cửa 4: phần vượt bằng gốc đang vay trừ phần tài sản cho phép đã làm tròn xuống, kết quả âm đặt về zero. Với tài sản 550 BEM, đã cho vay 500 BEM và tỷ lệ 90%, phần vượt là 5 BEM. Nhận định 55 BEM trước đây sai. Nguồn: system CQ-01/Q35.
- `CreditPolicy._decide:omitted-external-call-in-ledger` — Cửa 4: đây là thiếu sót bảng rà soát; mã gọi evaluator bên ngoài có giới hạn và đòi bản đối chiếu khớp. Nguồn: system F5-G.
- `TapePool._checkPolicy:version-read-order` — Cửa 4: quan sát current.version rồi candidate.version chỉ đổi thứ tự ưu tiên lỗi; không vượt cấp vay. Nguồn: pool-admin K6.
- `CheckStack.checkPool:pre-seed-donation` — Cửa 4: khi không có cổ phần, khoản tặng đã sync trở thành dự trữ; idle/supply zero với tracked/reserve dương là hợp lệ và không người gọi nào rút được. Nguồn: ứng viên trước cấp vốn mồi của deploy.
- `CheckStack.checkPoolSeeded:negligible-backstop-seed` — Cửa 4: khởi tạo đòi địa chỉ backstop khác zero. Cho vay sau đó kiểm tra quyền đòi tài sản thực tế của backstop. Câu chữ triển khai mô tả khoảng 10 BEM; không áp mức tối thiểu cứng chính xác. Nguồn: ứng viên seed-boundary/cover-drift của deploy.
- `TapePool.lendLimit:sybil-borrower-cap` — Cửa 4: địa chỉ riêng có hạn mức riêng. Giới hạn toàn cục 500 BEM, tỷ lệ 90% và backstop vẫn áp dụng. Mã không hứa hạn mức theo danh tính con người. Trái nhận định của đơn vị lens, mục 16 SPEC không có dòng chấp nhận riêng cho rủi ro chia địa chỉ này. Nguồn: các ranh giới được lens-factory chấp nhận; SPEC11.3.

### Ngoại lệ của mẫu / mẫu an toàn

- `TapePool.queueParam:lapsed-overwrite-event` — Mục không báo cáo §5: xếp hàng lại sau hết hạn phát ParamLapsed thay vì ParamCancelled; trạng thái, ETA và quyền vẫn đúng. Nguồn: pool-admin C-02/12.06.
- `TapePool.writeOff:reserve-release-at-winddown` — Mẫu an toàn §5: dự trữ bị khóa theo thiết kế, và §16 SPEC hoãn giải phóng nó. Chưa xác lập đường giải phóng dự trữ trái quyền. Nguồn: hành vi được pool-loans chấp nhận; template5.
- `RigAgent.initialize:events-access` — Mục không báo cáo §5: đề xuất event khởi tạo không có thay đổi trạng thái trái quyền hoặc tác động tài sản. Nguồn: src/RigAgent.sol:186.
- `TapePool._write:cyclomatic-complexity` — Mục không báo cáo §5: độ phức tạp chu trình không phải khai thác; mỗi khóa tham số có giới hạn và kiểm soát quyền/hàng đợi độc lập. Nguồn: src/TapePool.sol:935.
- `RigAgent.borrow:cyclomatic-complexity` — Mục không báo cáo §5: chỉ độ phức tạp không xác lập được việc vượt chốt vay. Nguồn: src/RigAgent.sol:276.
- `ITapeOutTransistors.NAND:naming-convention` — Mục không báo cáo §5: chính tả/đặt tên interface không phải khai thác. Nguồn: src/interfaces/IXLayer.sol:107.
- `ITapeOutCircuits.TAPEOUT_FEE:naming-convention` — Mục không báo cáo §5: chính tả/đặt tên interface không phải khai thác. Nguồn: src/interfaces/IXLayer.sol:121.
- `IPodMining.HALVING_PERIOD:naming-convention` — Mục không báo cáo §5: chính tả/đặt tên interface không phải khai thác. Nguồn: src/interfaces/IBsc.sol:50.
- `ITapeOutTransistors.LATCH:naming-convention` — Mục không báo cáo §5: chính tả/đặt tên interface không phải khai thác. Nguồn: src/interfaces/IXLayer.sol:108.
- `ITapePool.FEED_SETTLE:naming-convention` — Mục không báo cáo §5: chính tả/đặt tên interface không phải khai thác. Nguồn: src/interfaces/ITapePool.sol:17.
- `TapeLens._owns:too-many-digits` — Mục không báo cáo §5: 100000 là ngân sách gas có chủ đích cho đọc owner; định dạng các chữ số không ảnh hưởng bảo mật. Nguồn: src/TapeLens.sol:176.
- `RigReporter.lock:unindexed-event-address` — Mục không báo cáo §5: tham số event Locked không index ảnh hưởng lọc log, không ảnh hưởng quyền lock. Nguồn: src/feed/RigReporter.sol:31.
- `RigFeedReceiver.lock:unindexed-event-address` — Mục không báo cáo §5: tham số event Locked không index ảnh hưởng lọc log, không ảnh hưởng quyền lock. Nguồn: src/feed/RigFeedReceiver.sol:27.

**Owner Q6:** mức phí trễ bằng zero đến 2026-12-07 là cam kết vận hành, không phải chốt chặn theo lịch. Chủ dự án chấp nhận hành vi hiện tại về rút, thứ tự chuyển vào, giao dịch vào bằng zero, hạn mức và các ngoại lệ bằng chứng nêu trong Q6. Các quyết định bác bỏ/chấp nhận ban đầu giữ nguyên; câu chữ của SPEC và mẫu đã được căn chỉnh ngày 2026-11-13 (`docs/SPEC.md` §17). Câu trả lời này không biến mọi mâu thuẫn câu chữ thành tuân thủ đã được xác minh.

## Báo cáo và bằng chứng hỗ trợ

- [Vòng 1: mười đơn vị](2026-11-05-redeploy-4-prescan/round-1.md)
- [Vòng 2: Slither](2026-11-05-redeploy-4-prescan/round-2.md)
- [Vòng 3: rà soát thông thường trước đó](2026-11-05-redeploy-4-prescan/round-3.md)
- [Quyết định của chủ dự án cho từng nguyên nhân gốc đã gộp](2026-11-05-redeploy-4-prescan/runs/OWNER-DISPOSITIONS.md)
- [Bảng phân loại gốc](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-TABLE.md) và [bằng chứng chi tiết qua các cửa](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-EVIDENCE.md)
- [Yêu cầu người đọc](2026-11-05-redeploy-4-prescan/proofs/READER-REQUEST.md), [kết quả người đọc 1](2026-11-05-redeploy-4-prescan/proofs/READER-1.md), [kết quả người đọc 2](2026-11-05-redeploy-4-prescan/proofs/READER-2.md) và [phản hồi mới nhất của người viết](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-2.md): đã sửa; [kết quả người đọc 3](2026-11-05-redeploy-4-prescan/proofs/READER-3.md): PASS. Bản tiếng Việt: [báo cáo này](2026-11-05-redeploy-4-prescan.vi.md) và từng vòng.
- [Tài liệu của đợt quét](2026-11-05-redeploy-4-prescan/runs/README.md): sổ ghi của các đơn vị, test của đợt quét và log mà báo cáo dẫn tới, chép nguyên như lúc tạo ra. Đây là tệp chạy, giữ trên máy của chủ dự án và nằm ngoài git (quy tắc 7 của mẫu), nên các liên kết này chỉ mở được ở đó. Liên kết tới mã nguồn trỏ vào cây repo; số dòng là của commit được audit `ceed0a2`.

## Tuyên bố giới hạn

Kiểm toán bảo mật không thể chứng minh rằng không có lỗ hổng. Nó bị giới hạn về thời gian, công cụ và chuyên môn. Báo cáo này không bảo đảm an toàn. Phán quyết rà soát được cung cấp, kiểm thử cục bộ đạt và sự chấp nhận của chủ dự án không chứng minh mọi hành vi bên ngoài hoặc tương lai.
