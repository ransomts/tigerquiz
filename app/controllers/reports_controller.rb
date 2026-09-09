# Reports of finished games, per instructor.
class ReportsController < InstructorController
  def index
    render json: GameReport.listing(current_user)
  end

  def show
    game = find_game or return
    render json: GameReport.new(game).to_h
  end

  def csv
    game = find_game or return
    report = GameReport.new(game)
    send_data report.to_csv, type: "text/csv", disposition: "attachment", filename: report.csv_name
  end

  def review_quiz
    game = find_game or return
    threshold = json_body["threshold"]
    quiz = GameReport.new(game).review_quiz(threshold: threshold.nil? ? 0.6 : threshold)
    render json: { ok: true, id: quiz.slug, title: quiz.title, count: quiz.body["questions"].length }
  rescue GameReport::ReviewError => e
    render json: { error: e.message }, status: :bad_request
  end

  def destroy
    game = find_game or return
    game.destroy!
    render json: { ok: true }
  end

  def students
    render json: GameReport.students(current_user)
  end

  private

  def find_game
    game = current_user.games.find_by(id: params[:id])
    render json: { error: "No such game" }, status: :not_found unless game
    game
  end
end
